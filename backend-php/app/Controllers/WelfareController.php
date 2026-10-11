<?php

declare(strict_types=1);

namespace TheTeam\Controllers;

use TheTeam\Auth;
use TheTeam\Database;
use TheTeam\Log;
use TheTeam\Request;
use TheTeam\Response;
use TheTeam\Utils\LoanMath;
use TheTeam\Utils\Notifier;
use TheTeam\Utils\Settings;

/**
 * The welfare fund: contributions in, requests out.
 *
 * A port of backend/controllers/welfareController.js.
 *
 * Two decisions shape this file, and both were made after the alternative proved
 * to defeat the fund's purpose:
 *
 * A shortfall is reported, never enforced. Refusing an approval because the
 * recorded balance cannot cover it blocked the fund from doing the one thing it
 * exists for. Bookkeeping for a welfare fund runs behind reality - contributions
 * get recorded late, and the treasurer holds cash that never reaches the ledger -
 * so a perfectly healthy fund routinely reads as empty.
 *
 * Approval and disbursement are separate steps. Collapsing them made an approved
 * request look paid while the cash was still in the fund, which is precisely the
 * sort of thing that erodes trust in a fund.
 */
final class WelfareController
{
    // ---------------------------------------------------------------- helpers

    /** Reads a numeric setting. Garbage falls back rather than becoming NaN. */
    private static function numberSetting(string $key, float $fallback): float
    {
        return Settings::getNumber($key, $fallback);
    }

    /**
     * What the welfare fund currently holds.
     *
     * Money in is confirmed contributions. Money out is disbursed requests, not
     * merely approved ones: approving is a decision, and treating it as money
     * paid out is how a fund appears to have handed over cash it still holds.
     */
    public static function fundPosition(): array
    {
        $totalIn = (float) Database::scalar(
            "SELECT COALESCE(SUM(amount), 0) FROM welfare_contributions WHERE status = 'confirmed'"
        );

        $totalOut = (float) Database::scalar(
            "SELECT COALESCE(SUM(amount), 0) FROM welfare_requests WHERE status = 'disbursed'"
        );

        $pending = (float) Database::scalar(
            "SELECT COALESCE(SUM(amount), 0) FROM welfare_requests WHERE status = 'pending'"
        );

        $contributors = (int) Database::scalar(
            "SELECT COUNT(DISTINCT member_id) FROM welfare_contributions WHERE status = 'confirmed'"
        );

        return [
            'total_in' => $totalIn,
            'total_out' => $totalOut,
            'available' => LoanMath::round2($totalIn - $totalOut),
            'pending_requests' => $pending,
            'contributors' => $contributors,
        ];
    }

    /**
     * Whether a member may request welfare right now, and why not if they may not.
     *
     * Returned as a reason rather than a boolean so the member portal can say what
     * is actually missing instead of showing a dead button.
     */
    public static function eligibilityFor($memberId): array
    {
        if (Settings::get('welfare_enabled', '1') === '0') {
            return ['allowed' => false, 'reason' => 'The welfare fund is switched off.'];
        }

        $cap = self::numberSetting('welfare_max_request_amount', 0);
        $waiting = self::numberSetting('welfare_min_months_contributed', 0);

        if ($waiting > 0) {
            $months = (int) Database::scalar(
                <<<'SQL'
                    SELECT COUNT(DISTINCT DATE_FORMAT(contribution_date, '%Y-%m'))
                      FROM welfare_contributions
                     WHERE member_id = ? AND status = 'confirmed'
                    SQL,
                [$memberId]
            );

            if ($months < $waiting) {
                return [
                    'allowed' => false,
                    'reason' => sprintf(
                        'You have contributed for %d month(s). This group requires %d before a '
                        . 'request can be made.',
                        $months,
                        (int) $waiting
                    ),
                ];
            }
        }

        /*
         * The cap is deliberately NOT checked here.
         *
         * It is the largest single request the group will pay, so it belongs in
         * submitWelfareRequest where the requested amount is known. Comparing it
         * here against the fund's balance refused every request whenever the
         * balance fell below the cap, so a fund holding 1,000 with a 5,000 cap
         * told members they could not ask for anything and the real reason - that
         * they asked for too much - never surfaced.
         */
        return ['allowed' => true, 'reason' => null, 'cap' => $cap, 'waiting' => $waiting];
    }

    /**
     * Works out whether the fund can cover an amount, and by how much it cannot.
     *
     * @return array{underfunded: bool, shortfall: float}
     */
    private static function shortfallAgainst(float $amount): array
    {
        $position = self::fundPosition();
        $shortfall = LoanMath::round2($amount - $position['available']);

        return [
            'underfunded' => $shortfall > 0,
            'shortfall' => $shortfall > 0 ? $shortfall : 0.0,
        ];
    }

    // ---------------------------------------------------------------- reads

    /** Every welfare contribution. */
    public static function getAllWelfareContributions(Request $r): void
    {
        try {
            $contributions = Database::all(
                <<<'SQL'
                    SELECT w.*, m.full_name AS member_name
                      FROM welfare_contributions w
                      JOIN members m ON w.member_id = m.id
                     ORDER BY w.created_at DESC
                    SQL
            );

            Response::json([
                'contributions' => $contributions,
                'fund' => self::fundPosition(),
            ]);
        } catch (\Throwable $e) {
            Log::warn('getAllWelfareContributions: ' . $e->getMessage());
            Response::error('Failed to fetch welfare contributions.', 500);
        }
    }

    /**
     * Everything one member needs about the welfare fund.
     *
     * Scoped to their own rows. Before this existed a member could submit a
     * request and then had no way to see its outcome, which is the single most
     * likely reason for a fund to lose trust.
     */
    public static function getMyWelfare(Request $r): void
    {
        try {
            $memberId = $r->user['id'];

            $contributions = Database::all(
                <<<'SQL'
                    SELECT id, amount, contribution_date, payment_method, reference_number,
                           status, remarks
                      FROM welfare_contributions
                     WHERE member_id = ?
                     ORDER BY contribution_date DESC, id DESC
                    SQL,
                [$memberId]
            );

            $requests = Database::all(
                <<<'SQL'
                    SELECT w.id, w.amount, w.reason, w.status, w.request_date, w.approval_date,
                           a.full_name AS decided_by
                      FROM welfare_requests w
                      LEFT JOIN admins a ON w.approved_by = a.id
                     WHERE w.member_id = ?
                     ORDER BY w.request_date DESC, w.id DESC
                    SQL,
                [$memberId]
            );

            $contributed = (float) Database::scalar(
                "SELECT COALESCE(SUM(amount), 0) FROM welfare_contributions
                  WHERE member_id = ? AND status = 'confirmed'",
                [$memberId]
            );

            $received = (float) Database::scalar(
                "SELECT COALESCE(SUM(amount), 0) FROM welfare_requests
                  WHERE member_id = ? AND status = 'disbursed'",
                [$memberId]
            );

            // First day of this month, so the figure covers the month rather than
            // the day so far.
            $thisMonth = (float) Database::scalar(
                <<<'SQL'
                    SELECT COALESCE(SUM(amount), 0) FROM welfare_contributions
                     WHERE member_id = ? AND status = 'confirmed'
                       AND contribution_date = CURDATE() - INTERVAL (DAYOFMONTH(CURDATE()) - 1) DAY
                    SQL,
                [$memberId]
            );

            Response::json([
                'contributions' => $contributions,
                'requests' => $requests,
                'totals' => [
                    'contributed_all_time' => $contributed,
                    'received_all_time' => $received,
                    'contributed_this_month' => $thisMonth,
                    'usual_amount' => self::numberSetting('welfare_contribution', 0),
                ],
                'fund' => self::fundPosition(),
                'eligibility' => self::eligibilityFor($memberId),
                'can_contribute' => Settings::get('welfare_allow_self_contribution', '1') === '1'
                    && Settings::get('welfare_enabled', '1') === '1',
                'needs_approval' => Settings::get('welfare_request_needs_approval', '1') === '1',
            ]);
        } catch (\Throwable $e) {
            Log::warn('getMyWelfare: ' . $e->getMessage());
            Response::error('Failed to fetch your welfare details.', 500);
        }
    }

    /** All welfare requests, for the committee. */
    public static function getWelfareRequests(Request $r): void
    {
        try {
            $requests = Database::all(
                <<<'SQL'
                    SELECT w.*, m.full_name AS member_name, a.full_name AS approved_by_name
                      FROM welfare_requests w
                      JOIN members m ON w.member_id = m.id
                      LEFT JOIN admins a ON w.approved_by = a.id
                     ORDER BY w.created_at DESC
                    SQL
            );

            Response::json(['requests' => $requests, 'fund' => self::fundPosition()]);
        } catch (\Throwable $e) {
            Log::warn('getWelfareRequests: ' . $e->getMessage());
            Response::error('Failed to fetch welfare requests.', 500);
        }
    }

    /** The fund's position and rules, for the admin panel and the settings card. */
    public static function getWelfareFund(Request $r): void
    {
        try {
            Response::json([
                'fund' => self::fundPosition(),
                'rules' => [
                    'enabled' => Settings::get('welfare_enabled', '1') === '1',
                    'usual_amount' => self::numberSetting('welfare_contribution', 0),
                    'allow_self_contribution' => Settings::get('welfare_allow_self_contribution', '1') === '1',
                    'needs_approval' => Settings::get('welfare_request_needs_approval', '1') === '1',
                    'max_request_amount' => self::numberSetting('welfare_max_request_amount', 0),
                    'min_months_contributed' => self::numberSetting('welfare_min_months_contributed', 0),
                ],
            ]);
        } catch (\Throwable $e) {
            Log::warn('getWelfareFund: ' . $e->getMessage());
            Response::error('Failed to fetch the welfare fund position.', 500);
        }
    }

    // ---------------------------------------------------------------- writes

    /**
     * Records a welfare contribution.
     *
     * Serves both callers. An admin names the member; a member contributes for
     * themselves and is not trusted to name anyone else. That difference is the
     * whole reason this used to be unreachable from the member portal.
     */
    public static function recordWelfareContribution(Request $r): void
    {
        try {
            $isMember = ($r->user['type'] ?? '') === 'member';
            $body = $r->body();

            /*
             * Who the contribution is for.
             *
             * A member is always themselves. An admin may name any member, and if
             * they name nobody they are contributing for themselves - which is the
             * whole point of admins being members too.
             */
            if ($isMember) {
                $memberId = $r->user['id'];
            } elseif (!empty($body['member_id'])) {
                $memberId = $body['member_id'];
            } else {
                $own = Database::scalar('SELECT member_id FROM admins WHERE id = ?', [$r->user['id']]);

                if ($own === null || $own === '' || $own === null) {
                    Response::error('Choose which member this welfare contribution is for.', 400);
                }
                $memberId = $own;
            }

            // Validated as a positive number rather than merely truthy: the old
            // check accepted a string, and a negative amount would have drained
            // the fund.
            $raw = $body['amount'] ?? null;
            if ($raw === null || !is_numeric($raw)) {
                Response::error('Enter an amount greater than zero.', 400);
            }

            $value = (float) $raw;

            if (!is_finite($value) || $value <= 0) {
                Response::error('Enter an amount greater than zero.', 400);
            }

            if (Settings::get('welfare_enabled', '1') === '0') {
                Response::error('The welfare fund is switched off.', 400);
            }

            /*
             * Permission, moved here from the route's authorize().
             *
             * The route accepts both token kinds so members can reach it at all,
             * and authorize() only understands admin tokens. So an admin's right
             * to record on behalf of other people is checked here, explicitly,
             * rather than implied by having passed the middleware.
             */
            if (!$isMember
                && !Auth::hasPermission($r->user, 'record_contributions')) {
                Response::error('Access denied. Insufficient permissions.', 403);
            }

            // A member may only self-contribute when the group allows it.
            if ($isMember && Settings::get('welfare_allow_self_contribution', '1') === '0') {
                Response::error('Please ask an admin to record your welfare contribution.', 403);
            }

            $member = Database::one(
                'SELECT id, full_name, phone, email FROM members WHERE id = ?',
                [$memberId]
            );

            if ($member === null) {
                Response::error('Member not found.', 404);
            }

            $contributionId = Database::insert(
                <<<'SQL'
                    INSERT INTO welfare_contributions
                      (member_id, amount, contribution_date, payment_method,
                       reference_number, status, remarks)
                    VALUES (?, ?, CURDATE(), ?, ?, 'confirmed', ?)
                    SQL,
                [
                    $memberId,
                    $value,
                    !empty($body['payment_method']) ? $body['payment_method'] : 'cash',
                    !empty($body['reference_number']) ? $body['reference_number'] : null,
                    !empty($body['remarks']) ? $body['remarks'] : null,
                ]
            );

            // Tell the member their own contribution landed. A self-service
            // payment that produces no confirmation reads as money taken and not
            // received.
            Notifier::dispatch(
                'sms',
                (string) $member['phone'],
                'Your welfare contribution has been received. '
                . 'Thank you for supporting the fund.'
            );

            Response::json([
                'success' => true,
                'contribution_id' => $contributionId,
                'fund' => self::fundPosition(),
                'message' => 'Welfare contribution recorded.',
            ], 201);
        } catch (\Throwable $e) {
            Log::warn('recordWelfareContribution: ' . $e->getMessage());
            Response::error('Failed to record welfare contribution.', 500);
        }
    }

    /** A member asks for help from the fund. */
    public static function submitWelfareRequest(Request $r): void
    {
        try {
            $body = $r->body();
            $memberId = $r->user['id'];
            $reason = trim((string) ($body['reason'] ?? ''));

            $raw = $body['amount'] ?? null;
            if ($raw === null || !is_numeric($raw)) {
                Response::error('Enter an amount greater than zero.', 400);
            }

            $value = (float) $raw;

            if (!is_finite($value) || $value <= 0) {
                Response::error('Enter an amount greater than zero.', 400);
            }

            if ($reason === '') {
                Response::error('Please give a reason for the request.', 400);
            }

            $eligibility = self::eligibilityFor($memberId);

            if (!$eligibility['allowed']) {
                Response::error($eligibility['reason'], 403);
            }

            // The cap is checked against the requested amount, at request time -
            // so two requests approved in the same sitting cannot together
            // promise more than the group allows.
            if ($eligibility['cap'] > 0 && $value > $eligibility['cap']) {
                Response::error(sprintf(
                    'This group limits welfare requests to %s.',
                    self::formatAmount($eligibility['cap'])
                ), 400);
            }

            $needsApproval = Settings::get('welfare_request_needs_approval', '1') === '1';

            // When the group does not require approval, a valid request is settled
            // on submission rather than sitting in a queue nobody will clear.
            $status = $needsApproval ? 'pending' : 'disbursed';

            /*
             * Who decided, when no committee was involved.
             *
             * approved_by is a foreign key to admins(id), so a member's own id
             * cannot go there. NULL is the honest value: when the group runs
             * welfare without approval, the member submitted it themselves and
             * there is no admin to name. Recording a member id in an admin column
             * made the whole insert fail.
             */
            $deciderId = (!$needsApproval && ($r->user['type'] ?? '') !== 'member')
                ? $r->user['id']
                : null;

            $requestId = Database::transaction(function ($pdo) use (
                $memberId, $value, $reason, $status, $deciderId
            ) {
                $insert = $pdo->prepare(
                    <<<'SQL'
                        INSERT INTO welfare_requests
                          (member_id, amount, reason, status, request_date, approved_by, approval_date)
                        VALUES (?, ?, ?, ?, CURDATE(), ?, CURDATE())
                        SQL
                );
                $insert->execute([$memberId, $value, $reason, $status, $deciderId]);

                return (int) $pdo->lastInsertId();
            });

            $ledgerId = null;

            if (!$needsApproval) {
                // Money actually left the fund, so the cash book has to show it.
                $member = Database::one(
                    'SELECT id, full_name, phone FROM members WHERE id = ?',
                    [$memberId]
                );

                $ledgerId = Database::insert(
                    <<<'SQL'
                        INSERT INTO ledger_entries
                          (direction, category, description, amount, entry_date,
                           payment_method, member_id, recorded_by)
                        VALUES ('out', 'Welfare disbursement', ?, ?, CURDATE(), 'cash', ?, ?)
                        SQL,
                    [
                        sprintf('Welfare to %s: %s', $member['full_name'], $reason),
                        $value,
                        $memberId,
                        $deciderId,
                    ]
                );

                Notifier::dispatch(
                    'sms',
                    (string) $member['phone'],
                    'Your welfare request has been paid.'
                );
            } else {
                $member = Database::one('SELECT phone FROM members WHERE id = ?', [$memberId]);

                Notifier::dispatch(
                    'sms',
                    (string) ($member['phone'] ?? ''),
                    'Your welfare request has been received and is waiting for approval.'
                );
            }

            Response::json([
                'success' => true,
                'request_id' => $requestId,
                'status' => $status,
                'needs_approval' => $needsApproval,
                'ledger_id' => $ledgerId,
                'fund' => self::fundPosition(),
                'message' => $needsApproval
                    ? 'Welfare request submitted and waiting for approval.'
                    : 'Welfare request submitted and paid.',
            ], 201);
        } catch (\Throwable $e) {
            Log::warn('submitWelfareRequest: ' . $e->getMessage());
            Response::error('Failed to submit welfare request.', 500);
        }
    }

    /** Approves a request. The committee's decision. */
    public static function approveWelfareRequest(Request $r): void
    {
        try {
            $id = $r->param('id');

            $request = Database::one(
                <<<'SQL'
                    SELECT w.id, w.member_id, w.amount, w.reason, w.status, m.full_name, m.phone
                      FROM welfare_requests w
                      JOIN members m ON w.member_id = m.id
                     WHERE w.id = ?
                    SQL,
                [$id]
            );

            if ($request === null) {
                Response::error('Welfare request not found.', 404);
            }

            // Approving an already-decided request would let a second click
            // overwrite the first decision and pay the member twice.
            if ($request['status'] !== 'pending') {
                Response::error(sprintf('This request was already %s.', $request['status']), 409);
            }

            $amount = (float) $request['amount'];
            $shortfall = self::shortfallAgainst($amount);

            if ($shortfall['underfunded']) {
                // Loud, because the committee is making a call with incomplete
                // information and should know the ledger disagrees with the cash.
                Log::warn(sprintf(
                    '[welfare] approving request %s for %.2f with only %.2f recorded in the '
                    . 'fund (short by %.2f)',
                    $id,
                    $amount,
                    self::fundPosition()['available'],
                    $shortfall['shortfall']
                ));
            }

            Database::run(
                "UPDATE welfare_requests
                    SET status = 'approved', approved_by = ?, approval_date = CURDATE()
                  WHERE id = ?",
                [$r->user['id'], $id]
            );

            Notifier::dispatch(
                'sms',
                (string) $request['phone'],
                'Your welfare request has been approved. It will be paid out shortly.'
            );

            Response::json([
                'success' => true,
                'message' => $shortfall['underfunded']
                    ? 'Welfare request approved, but the fund is short of this amount.'
                    : 'Welfare request approved.',
                'underfunded' => $shortfall['underfunded'],
                'shortfall' => $shortfall['shortfall'],
                'fund' => self::fundPosition(),
            ]);
        } catch (\Throwable $e) {
            Log::warn('approveWelfareRequest: ' . $e->getMessage());
            Response::error('Failed to approve welfare request.', 500);
        }
    }

    /**
     * Pays an approved request out.
     *
     * Separate from approval because approving says the committee agreed and
     * disbursing says the money moved.
     */
    public static function disburseWelfareRequest(Request $r): void
    {
        try {
            $id = $r->param('id');

            $request = Database::one(
                <<<'SQL'
                    SELECT w.id, w.member_id, w.amount, w.reason, w.status, m.full_name, m.phone
                      FROM welfare_requests w
                      JOIN members m ON w.member_id = m.id
                     WHERE w.id = ?
                    SQL,
                [$id]
            );

            if ($request === null) {
                Response::error('Welfare request not found.', 404);
            }

            if ($request['status'] !== 'approved') {
                Response::error(sprintf(
                    'Only an approved request can be paid out. This one is %s.',
                    $request['status']
                ), 409);
            }

            $amount = (float) $request['amount'];
            $shortfall = self::shortfallAgainst($amount);

            if ($shortfall['underfunded']) {
                Log::warn(sprintf(
                    '[welfare] paying out request %s for %.2f with only %.2f recorded in the '
                    . 'fund (short by %.2f)',
                    $id,
                    $amount,
                    self::fundPosition()['available'],
                    $shortfall['shortfall']
                ));
            }

            // Status change and ledger entry together: a disbursed request with no
            // ledger entry is money that left the fund with no record of where.
            $ledgerId = Database::transaction(function ($pdo) use ($request, $r) {
                $update = $pdo->prepare("UPDATE welfare_requests SET status = 'disbursed' WHERE id = ?");
                $update->execute([$request['id']]);

                $entry = $pdo->prepare(
                    <<<'SQL'
                        INSERT INTO ledger_entries
                          (direction, category, description, amount, entry_date,
                           payment_method, member_id, recorded_by)
                        VALUES ('out', 'Welfare disbursement', ?, ?, CURDATE(), 'cash', ?, ?)
                        SQL
                );
                $entry->execute([
                    sprintf('Welfare to %s: %s', $request['full_name'], $request['reason']),
                    $request['amount'],
                    $request['member_id'],
                    $r->user['id'],
                ]);

                return (int) $pdo->lastInsertId();
            });

            Notifier::dispatch(
                'sms',
                (string) $request['phone'],
                'Your welfare payment has been sent. Thank you.'
            );

            Response::json([
                'success' => true,
                'ledger_id' => $ledgerId,
                'message' => $shortfall['underfunded']
                    ? 'Welfare request paid out. Note: the fund is now short of its recorded contributions.'
                    : 'Welfare request paid out.',
                'underfunded' => $shortfall['underfunded'],
                'shortfall' => $shortfall['shortfall'],
                'fund' => self::fundPosition(),
            ]);
        } catch (\Throwable $e) {
            Log::warn('disburseWelfareRequest: ' . $e->getMessage());
            Response::error('Failed to pay out welfare request.', 500);
        }
    }

    /** Declines a request. */
    public static function rejectWelfareRequest(Request $r): void
    {
        try {
            $id = $r->param('id');

            $request = Database::one(
                <<<'SQL'
                    SELECT w.id, w.status, m.phone FROM welfare_requests w
                      JOIN members m ON w.member_id = m.id
                     WHERE w.id = ?
                    SQL,
                [$id]
            );

            if ($request === null) {
                Response::error('Welfare request not found.', 404);
            }

            if ($request['status'] !== 'pending') {
                Response::error(sprintf('This request was already %s.', $request['status']), 409);
            }

            Database::run(
                <<<'SQL'
                    UPDATE welfare_requests
                       SET status = 'rejected', approved_by = ?, approval_date = CURDATE()
                     WHERE id = ?
                    SQL,
                [$r->user['id'], $id]
            );

            Notifier::dispatch(
                'sms',
                (string) $request['phone'],
                'Your welfare request was not approved. Please speak to the committee.'
            );

            Response::json([
                'success' => true,
                'message' => 'Welfare request rejected.',
                'fund' => self::fundPosition(),
            ]);
        } catch (\Throwable $e) {
            Log::warn('rejectWelfareRequest: ' . $e->getMessage());
            Response::error('Failed to reject welfare request.', 500);
        }
    }

    /**
     * A money figure for a message.
     *
     * No thousands separators, unlike the Node version's toLocaleString(). Those
     * differ by locale and by ICU build, so the same request would produce
     * "5,000" on one server and "5000" on another - and the cap is quoted back to
     * a member as the limit they may ask for, where an ambiguous figure is worse
     * than a plain one.
     */
    private static function formatAmount(float $amount): string
    {
        return rtrim(rtrim(number_format($amount, 2, '.', ''), '0'), '.');
    }
}