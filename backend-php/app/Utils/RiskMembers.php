<?php

declare(strict_types=1);

namespace TheTeam\Utils;

use TheTeam\Database;

/**
 * Detects members who need chasing.
 *
 * A port of backend/utils/riskMembers.js.
 *
 * Used by the dashboard widget and by the reminder sender, so the two can never
 * disagree about who is behind.
 */
final class RiskMembers
{
    /** "YYYY-MM" for a date. */
    public static function monthKey(\DateTimeInterface $date): string
    {
        return $date->format('Y-m');
    }

    /**
     * Whole months between two dates.
     *
     * Counts to the first of each month, and then backs off one if the day of the
     * month has not been reached. Without that adjustment a payment on the 28th
     * and a report on the 30th reads as a full month gone when it is not.
     */
    public static function monthsBetween(\DateTimeInterface $from, \DateTimeInterface $to): int
    {
        $a = new \DateTimeImmutable(sprintf('%04d-%02d-01', $from->format('Y'), $from->format('m')));
        $b = new \DateTimeImmutable(sprintf('%04d-%02d-01', $to->format('Y'), $to->format('m')));

        $months = ((int) $b->format('Y') - (int) $a->format('Y')) * 12
            + ((int) $b->format('m') - (int) $a->format('m'));

        if ((int) $to->format('j') < (int) $from->format('j')) {
            $months--;
        }

        return max(0, $months);
    }

    /**
     * Everyone behind on contributions, loans, or both.
     *
     * @return array{month:string, monthlyAmount:float, members:array, summary:array}
     */
    public static function find(): array
    {
        $now = new \DateTimeImmutable('today');
        $currentMonth = self::monthKey($now);
        $today = $now->format('Y-m-d');

        $monthlyContribution = Settings::getNumber('monthly_contribution', 1000);

        $rows = Database::all(
            <<<'SQL'
                SELECT
                  m.id, m.full_name, m.phone, m.email, m.joined_date,
                  (SELECT MAX(contribution_date) FROM contributions c
                    WHERE c.member_id = m.id AND c.status = 'confirmed')            AS last_contribution,
                  (SELECT COALESCE(SUM(amount), 0) FROM contributions c
                    WHERE c.member_id = m.id AND c.status = 'confirmed')            AS total_contributed,
                  (SELECT COUNT(*) FROM contributions c
                    WHERE c.member_id = m.id AND c.status = 'confirmed'
                      AND DATE_FORMAT(contribution_date, '%Y-%m') = ?)              AS paid_this_month,
                  (SELECT COALESCE(SUM(balance), 0) FROM loans l
                    WHERE l.member_id = m.id AND l.status IN ('active','disbursed')) AS loan_balance,
                  (SELECT MIN(due_date) FROM loans l
                    WHERE l.member_id = m.id AND l.status IN ('active','disbursed')
                      AND l.balance > 0)                                             AS loan_due_date,
                  (SELECT COALESCE(SUM(balance), 0) FROM loans l
                    WHERE l.member_id = m.id AND l.status = 'defaulted')             AS defaulted_amount
                FROM members m
                WHERE m.status = 'active'
                ORDER BY m.full_name
                SQL,
            [$currentMonth]
        );

        $members = [];

        foreach ($rows as $row) {
            $joined = self::parseDate($row['joined_date']) ?? $now;
            $monthsSinceJoin = self::monthsBetween($joined, $now);

            // A brand new member is not chased before the group has had a chance
            // to collect.
            if ($monthsSinceJoin <= 0 && (int) $row['paid_this_month'] === 0) {
                continue;
            }

            $lastPaid = self::parseDate($row['last_contribution']) ?? $joined;
            $monthsMissed = self::monthsBetween($lastPaid, $now);
            $notPaidThisMonth = (int) $row['paid_this_month'] === 0;

            $loanBalance = (float) $row['loan_balance'];
            $loanOverdue = !empty($row['loan_due_date'])
                && $row['loan_due_date'] < $today
                && $loanBalance > 0;

            $daysOverdue = $loanOverdue
                ? (int) floor(($now->getTimestamp()
                    - self::parseDate($row['loan_due_date'])->getTimestamp()) / 86400)
                : 0;

            $defaulted = (float) $row['defaulted_amount'] > 0;

            if (!$notPaidThisMonth && !$loanOverdue && !$defaulted) {
                continue;
            }

            // The worst problem decides the headline reason.
            $reason = 'on_track';
            $severity = 'low';
            $detail = '';
            $amount = 0.0;

            if ($defaulted) {
                $reason = 'defaulted_loan';
                $severity = 'critical';
                $amount = (float) $row['defaulted_amount'];
                $detail = sprintf('Has a defaulted loan of KES %s', self::money($amount));
            } elseif ($loanOverdue) {
                $reason = 'overdue_loan';
                $severity = $daysOverdue > 30 ? 'critical' : 'high';
                $amount = $loanBalance;
                $detail = sprintf(
                    'Loan of KES %s was due %s (%d days ago)',
                    self::money($loanBalance),
                    $row['loan_due_date'],
                    $daysOverdue
                );
            } elseif ($notPaidThisMonth && $monthsMissed >= 2) {
                $reason = 'missed_contributions';
                $severity = 'high';
                $amount = $monthlyContribution * $monthsMissed;
                $detail = sprintf('Has not contributed for %d months', $monthsMissed);
            } elseif ($notPaidThisMonth) {
                $reason = 'not_paid';
                $severity = 'medium';
                $amount = $monthlyContribution;
                $detail = 'Has not contributed this month';
            } elseif ($monthsMissed >= 1) {
                $reason = 'missed_contributions';
                $severity = 'medium';
                $amount = $monthlyContribution * $monthsMissed;
                $detail = 'Last contribution was ' . $row['last_contribution'];
            }

            // Loan arrears outrank a missed contribution for the headline figure.
            if ($reason === 'missed_contributions' && $loanBalance > 0) {
                $detail .= sprintf(' · also owes KES %s on a loan', self::money($loanBalance));
            }

            $members[] = [
                'member_id' => $row['id'],
                'full_name' => $row['full_name'],
                'phone' => $row['phone'],
                'email' => $row['email'],
                'last_contribution' => $row['last_contribution'],
                'months_missed' => $monthsMissed,
                'reason' => $reason,
                'severity' => $severity,
                'detail' => $detail,
                'amount' => LoanMath::round2($amount),
                'loan_balance' => LoanMath::round2($loanBalance),
                'loan_due_date' => $row['loan_due_date'],
                'days_overdue' => $daysOverdue,
            ];
        }

        // Worst first, then largest. The order a treasurer would work through.
        $rank = ['critical' => 0, 'high' => 1, 'medium' => 2, 'low' => 3];

        usort($members, static function (array $a, array $b) use ($rank): int {
            $bySeverity = $rank[$a['severity']] <=> $rank[$b['severity']];

            return $bySeverity !== 0 ? $bySeverity : ($b['amount'] <=> $a['amount']);
        });

        $countReason = static function (string $reason) use ($members): int {
            return count(array_filter($members, static fn(array $m) => $m['reason'] === $reason));
        };

        return [
            'month' => $currentMonth,
            'monthlyAmount' => $monthlyContribution,
            'members' => $members,
            'summary' => [
                'not_paid' => $countReason('not_paid'),
                'missed_contributions' => $countReason('missed_contributions'),
                'overdue_loans' => $countReason('overdue_loan'),
                'defaulted' => $countReason('defaulted_loan'),
                'total' => count($members),
                'total_amount' => LoanMath::round2(array_sum(array_column($members, 'amount'))),
            ],
        ];
    }

    /** A date column as a DateTimeImmutable, or null when it is absent. */
    private static function parseDate($value): ?\DateTimeImmutable
    {
        if ($value === null || $value === '') {
            return null;
        }

        $text = substr((string) $value, 0, 10);
        $date = \DateTimeImmutable::createFromFormat('!Y-m-d', $text);

        return $date === false ? null : $date;
    }

    /**
     * A money figure with thousands separators.
     *
     * Written out rather than number_format with grouping, so the separators are
     * identical on every machine: ICU's locale rules differ between builds, and a
     * reminder that reads "1,000" on one server and "1.000" on another is a
     * message nobody trusts.
     */
    private static function money(float $amount): string
    {
        $whole = (int) round($amount);

        return number_format($whole, 0, '.', ',');
    }
}