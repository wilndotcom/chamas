<?php

declare(strict_types=1);

namespace TheTeam\Controllers;

use TheTeam\Database;
use TheTeam\Log;
use TheTeam\Request;
use TheTeam\Response;
use TheTeam\Utils\MpesaConfig;
use TheTeam\Utils\Notifier;
use TheTeam\Utils\Phone;

/**
 * M-Pesa: sending STK prompts and receiving what Safaricom sends back.
 *
 * A port of backend/controllers/mpesaController.js.
 *
 * The callbacks are deliberately unauthenticated. Safaricom posts to them with
 * no credentials of ours, so they cannot sit behind the usual token check; they
 * are identified instead by the transaction ID they quote, which only Safaricom
 * and this server have seen. Locking them behind auth would mean every
 * confirmation is rejected and every payment stays pending forever.
 *
 * Both callbacks answer Accept even when something goes wrong. A non-zero code
 * tells Safaricom the payment failed, and it will retry a payment that actually
 * succeeded.
 */
final class MpesaController
{
    /** How long to wait on Safaricom before giving up. */
    private const TIMEOUT_SECONDS = 20;

    // ---------------------------------------------------------------- admin

    /** Sends an STK prompt that records a contribution when it is paid. */
    public static function stkPush(Request $r): void
    {
        try {
            $body = $r->body();
            $phone = $body['phone'] ?? null;
            $amount = $body['amount'] ?? null;

            if (!$phone || !$amount) {
                Response::error('Phone and amount are required.', 400);
            }

            // Same conversion as the test prompt: Daraja rejects a local-format
            // number with 400.002.02, which reads as Safaricom being difficult
            // rather than a format the app should have converted.
            $dialable = Phone::toInternational($phone);

            if ($dialable === null) {
                Response::error(
                    'That does not look like a Kenyan phone number. Use the local form '
                    . '(0712345678) or the international one (254712345678).',
                    400
                );
            }

            $config = MpesaConfig::get();

            if (!MpesaConfig::isConfigured($config)) {
                // Said plainly instead of letting Safaricom reject an opaque
                // request the operator cannot interpret.
                Response::error(
                    'M-Pesa is not configured. Add the consumer key, consumer secret, shortcode '
                    . 'and STK passkey in Settings, or set MPESA_* in the environment.',
                    400
                );
            }

            /*
             * The callback must be reachable in production, or a payment succeeds
             * and the receipt vanishes.
             *
             * In the Daraja SANDBOX it does not have to be: Safaricom simulates
             * the callback, so a placeholder is enough to exercise STK Push
             * locally. Refusing it outright meant the only way to find out whether
             * STK Push worked at all - by sending one - was blocked before
             * anything was sent.
             */
            $callbackPlaceholder = !MpesaConfig::callbackReachable($config);
            $callbackWarning = null;

            if ($callbackPlaceholder) {
                if ($config['env'] === 'production') {
                    Response::json([
                        'error' => 'MPESA_CALLBACK_URL is missing or still the sample value ('
                            . ($config['callbackUrl'] ?: 'unset')
                            . ') and this server is in PRODUCTION. Safaricom must be able to reach '
                            . 'it over the internet, and it cannot reach localhost. Set your real '
                            . 'domain in Settings -> M-Pesa, or in backend/.env.production.',
                        'field' => 'mpesa_callback_url',
                    ], 400);
                }

                $callbackWarning = 'Heads up: the callback URL is still the sample value ('
                    . ($config['callbackUrl'] ?: 'unset')
                    . '), so Safaricom will not be able to deliver the payment confirmation back '
                    . 'to this server. The STK prompt will still be sent and you will get a '
                    . 'checkout ID, but the transaction will stay "pending" here. This is fine '
                    . 'for sandbox testing.';
            }

            try {
                $token = self::accessToken($config);
            } catch (DarajaException $e) {
                Log::warn('[mpesa] token request failed: ' . ($e->detail['daraja_code'] ?? '')
                    . ' ' . ($e->detail['daraja_message'] ?? ''));

                Response::json(array_merge([
                    'error' => 'Safaricom rejected the credentials'
                        . (($e->detail['daraja_message'] ?? null)
                            ? ': ' . $e->detail['daraja_message'] : '.'),
                ], $e->detail), 502);
            }

            $data = self::sendStkPrompt($config, [
                'accessToken' => $token,
                'phone' => $dialable ?? $phone,
                'amount' => $amount,
                'reference' => $body['reference'] ?? null,
                'description' => $body['description'] ?? null,
            ]);

            $checkoutId = $data['CheckoutRequestID'] ?? null;

            Database::run(
                <<<'SQL'
                    INSERT INTO mpesa_transactions
                      (transaction_id, phone, amount, reference, type, status, response_data)
                    VALUES (?, ?, ?, ?, 'stk_push', 'pending', ?)
                    SQL,
                [$checkoutId, $phone, $amount, $body['reference'] ?? null, json_encode($data)]
            );

            Response::json([
                'success' => true,
                'checkout_request_id' => $checkoutId,
                'message' => 'STK Push sent. Please check your phone.',

                // Surfaced rather than swallowed, so an unreachable callback is
                // visible instead of quietly leaving the transaction on "pending".
                'warning' => $callbackWarning,
            ]);
        } catch (DarajaException $e) {
            // Daraja's own code is far more useful than a generic failure. A
            // rejection here is a configuration problem on the Daraja side, so it
            // is reported as a bad gateway with the code and a hint rather than as
            // an internal server error - which sends the operator looking in
            // exactly the wrong place.
            Log::warn('[mpesa] STK push rejected: '
                . ($e->detail['daraja_code'] ?? '(no code)') . ' '
                . ($e->detail['daraja_message'] ?? $e->getMessage()));

            Response::json(array_merge([
                'error' => ($e->detail['daraja_message'] ?? null)
                    ? 'Safaricom rejected the request: ' . $e->detail['daraja_message']
                    : 'Could not reach Safaricom. Check the server internet connection and try again.',
            ], $e->detail), 502);
        } catch (\Throwable $e) {
            Log::warn('[mpesa] STK push failed: ' . $e->getMessage());
            Response::error('Failed to send the STK prompt.', 500);
        }
    }

    /**
     * Sends one STK prompt without recording anything.
     *
     * For checking that the Daraja setup works before trusting it with a member's
     * money.
     *
     * Deliberately does NOT write to mpesa_transactions or contributions. A test
     * prompt is not a payment, and recording one would put a phantom transaction
     * in the ledger that no confirmation will ever arrive to close.
     */
    public static function stkTestPrompt(Request $r): void
    {
        try {
            $body = $r->body();
            $phone = $body['phone'] ?? null;
            $amount = $body['amount'] ?? null;

            if (!$phone || !$amount) {
                Response::error('Phone and amount are required.', 400);
            }

            if (!is_numeric($amount) || (float) $amount <= 0) {
                Response::error('The amount must be greater than zero.', 400);
            }

            /*
             * Daraja wants 254712345678. A member's number is stored as
             * 0712345678 and typed into this box in that form, so passing it
             * through unchanged gets the whole request rejected with
             * 400.002.02 "Invalid PhoneNumber" - which reads like Safaricom being
             * difficult rather than a format the app should have converted.
             */
            $dialable = Phone::toInternational($phone);

            if ($dialable === null) {
                Response::error(
                    'That does not look like a Kenyan phone number. Use the local form '
                    . '(0712345678) or the international one (254712345678).',
                    400
                );
            }

            $config = MpesaConfig::get();

            if (!MpesaConfig::isConfigured($config)) {
                Response::error(
                    'M-Pesa is not configured. Add the consumer key, consumer secret, shortcode '
                    . 'and STK passkey in Settings, or set MPESA_* in the environment.',
                    400
                );
            }

            try {
                $token = self::accessToken($config);
            } catch (DarajaException $e) {
                Log::warn('[mpesa] test prompt token failed: '
                    . ($e->detail['daraja_code'] ?? '') . ' ' . ($e->detail['daraja_message'] ?? ''));

                Response::json(array_merge([
                    'error' => 'Safaricom rejected the credentials'
                        . (($e->detail['daraja_message'] ?? null)
                            ? ': ' . $e->detail['daraja_message'] : '.'),
                ], $e->detail), 502);
            }

            $callbackPlaceholder = !MpesaConfig::callbackReachable($config);

            /*
             * Refused in production without a real callback, exactly as stkPush is.
             *
             * This guard was missing here in an earlier version, so the test button
             * could reach Safaricom's LIVE endpoint while confirmations had
             * nowhere to arrive: the prompt goes out to a real shortcode, the
             * customer can accept it, and the payment is lost with no receipt.
             *
             * Checked before the call, and stkPush checks in the same position,
             * because in sandbox a missing callback costs nothing while in
             * production it costs the member their money.
             */
            if ($config['env'] === 'production' && $callbackPlaceholder) {
                Response::json([
                    'error' => 'The M-Pesa environment is set to PRODUCTION but the callback URL '
                        . 'is still the sample value (' . ($config['callbackUrl'] ?: 'unset')
                        . '). Safaricom could send a live payment request to a real shortcode and '
                        . 'the confirmation would go nowhere, so the money would be taken and never '
                        . 'recorded. Set a real public https callback URL in Settings first, or '
                        . 'switch the environment back to sandbox to test.',
                    'field' => 'mpesa_callback_url',
                ], 400);
            }

            $data = self::sendStkPrompt($config, [
                'accessToken' => $token,
                'phone' => $dialable,
                'amount' => $amount,
                'reference' => $body['reference'] ?? null,
                'description' => $body['description'] ?? 'Test prompt',
            ]);

            Response::json([
                'success' => true,
                'checkout_request_id' => $data['CheckoutRequestID'] ?? null,
                'customer_message' => $data['CustomerMessage'] ?? null,
                'message' => 'STK prompt sent. Check the phone for the M-Pesa prompt.',

                // Said plainly, because a test that appears to pass while
                // confirmations can never arrive is exactly the false confidence
                // this button exists to remove.
                'warning' => $callbackPlaceholder
                    ? 'The callback URL is still the sample value ('
                        . ($config['callbackUrl'] ?: 'unset')
                        . '), so the prompt will reach the phone but no confirmation can come back '
                        . 'to this server. That is expected while testing locally.'
                    : null,
                'recorded' => false,
            ]);
        } catch (DarajaException $e) {
            Log::warn('[mpesa] test prompt rejected: '
                . ($e->detail['daraja_code'] ?? '(no code)') . ' '
                . ($e->detail['daraja_message'] ?? $e->getMessage()));

            Response::json(array_merge([
                'error' => ($e->detail['daraja_message'] ?? null)
                    ? 'Safaricom rejected the request: ' . $e->detail['daraja_message']
                    : 'Could not reach Safaricom. Check the server internet connection and try again.',
            ], $e->detail), 502);
        } catch (\Throwable $e) {
            Log::warn('[mpesa] test prompt failed: ' . $e->getMessage());
            Response::error('Failed to send the test prompt.', 500);
        }
    }

    /**
     * Registers the paybill's validation and confirmation URLs with Safaricom.
     *
     * This has to be done once per shortcode, and only Safaricom can accept the
     * change, so it cannot be done from the settings screen itself. Having a
     * button here is what makes it reachable without writing curl by hand.
     */
    public static function registerC2BUrls(Request $r): void
    {
        try {
            $config = MpesaConfig::get();

            if (!MpesaConfig::isConfigured($config)) {
                Response::error('M-Pesa is not configured yet.', 400);
            }

            // Refused rather than forwarded: a successful registration against a
            // placeholder URL looks like success and silently breaks every C2B
            // payment.
            if (!MpesaConfig::callbackReachable($config)) {
                Response::json([
                    'error' => 'The callback URL is still the sample value ('
                        . ($config['callbackUrl'] ?: 'unset')
                        . '), so Safaricom would be told to post to an address that does not '
                        . 'exist. Set your real https domain in Settings first, then register.',
                    'field' => 'mpesa_callback_url',
                ], 400);
            }

            $urls = MpesaConfig::c2bEndpoints($config);
            $token = self::accessToken($config);

            $data = self::daraja('POST', $config, '/mpesa/c2b/v1/registerurl', [
                'ShortCode' => $config['shortcode'],
                'ResponseType' => 'Completed',
                'ConfirmationURL' => $urls['confirmation'],
                'ValidationURL' => $urls['validation'],
            ], $token);

            Response::json(['success' => true, 'data' => $data, 'registered' => $urls]);
        } catch (DarajaException $e) {
            Log::warn('[mpesa] C2B register failed: '
                . ($e->detail['daraja_code'] ?? '') . ' ' . ($e->detail['daraja_message'] ?? ''));

            Response::json(array_merge([
                'error' => ($e->detail['daraja_message'] ?? null)
                    ? 'Safaricom rejected the request: ' . $e->detail['daraja_message']
                    : 'Could not reach Safaricom. Check the server internet connection and try again.',
            ], $e->detail), 502);
        } catch (\Throwable $e) {
            Log::warn('[mpesa] C2B register failed: ' . $e->getMessage());
            Response::error('Failed to register the C2B URLs.', 500);
        }
    }

    /**
     * What M-Pesa credentials the API is actually using, and where each came from.
     *
     * This is what makes the Settings screen honest: an operator can see that a
     * key they typed is in use, or that the API is still falling back to the
     * environment.
     */
    public static function mpesaStatus(Request $r): void
    {
        try {
            $config = MpesaConfig::get(true);

            Response::json([
                'configured' => MpesaConfig::isConfigured($config),
                'environment' => $config['env'],

                // The endpoint the environment resolves to. Shown because
                // "sandbox" and "production" are labels: seeing the host confirms
                // which Daraja is actually being called before a test prompt moves
                // real money.
                'base_url' => $config['base_url'],

                'values' => [
                    // Never echo the secret or passkey back; only whether one is
                    // present.
                    'consumer_key' => $config['consumerKey']
                        ? self::mask($config['consumerKey']) : null,
                    'consumer_secret' => $config['consumerSecret'] ? 'set' : null,
                    'shortcode' => $config['shortcode'] ?: null,
                    'passkey' => $config['passkey'] ? 'set' : null,
                    'paybill' => $config['paybill'] ?: null,
                ],
                'source' => $config['source'],
                'callback_url' => $config['callbackUrl'] ?: null,

                // Both facts shown in Settings: whether Safaricom could deliver a
                // confirmation at all, and which URLs a C2B registration would
                // publish.
                'callback_reachable' => MpesaConfig::callbackReachable($config),
                'c2b_endpoints' => MpesaConfig::c2bEndpoints($config),
                'note' => 'source shows where each value comes from: "settings" means the value '
                    . 'saved in this screen is in use, "env" means the API is falling back to the '
                    . 'environment file.',
            ]);
        } catch (\Throwable $e) {
            Log::warn('mpesaStatus: ' . $e->getMessage());
            Response::error('Failed to read M-Pesa configuration.', 500);
        }
    }

    // ------------------------------------------------------------ callbacks

    /**
     * The STK callback Safaricom posts once the customer has paid.
     *
     * Always answers ResultCode 0, including on an unexpected payload. Anything
     * else makes Safaricom treat the payment as failed and retry it, which would
     * duplicate a payment that genuinely succeeded.
     */
    public static function mpesaCallback(Request $r): void
    {
        $accept = static fn() => Response::json(['ResultCode' => 0, 'ResultDesc' => 'Accepted']);

        try {
            $body = $r->body();
            $stk = $body['Body']['stkCallback'] ?? [];
            $resultCode = $stk['ResultCode'] ?? null;
            $checkoutId = $stk['CheckoutRequestID'] ?? null;

            if ((int) $resultCode === 0) {
                $items = $stk['CallbackMetadata']['Item'] ?? [];

                $amount = null;
                $receipt = null;
                $phone = null;

                foreach ($items as $item) {
                    switch ($item['Name'] ?? '') {
                        case 'Amount':
                            $amount = $item['Value'] ?? null;
                            break;
                        case 'MpesaReceiptNumber':
                            $receipt = $item['Value'] ?? null;
                            break;
                        case 'PhoneNumber':
                            $phone = $item['Value'] ?? null;
                            break;
                    }
                }

                if ($checkoutId !== null) {
                    Database::run(
                        "UPDATE mpesa_transactions
                            SET status = 'success', response_data = ?
                          WHERE transaction_id = ?",
                        [json_encode($body), $checkoutId]
                    );
                }

                // Match the payer to a member and record the contribution.
                // Without this the money arrives and is marked success, but no
                // member is credited and no ledger entry exists - the payment is
                // real and the books never see it.
                $recorded = self::recordSuccessfulPayment(
                    $amount,
                    $receipt,
                    $phone,
                    'mpesa_stk'
                );

                if ($recorded['matched'] && empty($recorded['duplicate'])) {
                    Log::startup("[mpesa] recorded contribution {$recorded['contributionId']} "
                        . "for member {$recorded['memberId']}");
                } elseif (!empty($recorded['duplicate'])) {
                    // Safaricom retried a callback that was already processed.
                    // Expected, and must not be reported as an error.
                    Log::startup("[mpesa] duplicate callback ignored for receipt {$receipt}");
                } else {
                    // Real money from a number no member claims. Logged loudly:
                    // this is the case an operator has to act on, not swallow.
                    Log::warn("[mpesa] UNMATCHED payment: KES {$amount} from {$phone}, "
                        . "receipt {$receipt} - {$recorded['reason']}");
                }
            } elseif ($checkoutId !== null) {
                Database::run(
                    "UPDATE mpesa_transactions
                        SET status = 'failed', response_data = ?
                      WHERE transaction_id = ?",
                    [json_encode($body), $checkoutId]
                );
            }

            $accept();
        } catch (\Throwable $e) {
            Log::warn('M-Pesa callback error: ' . $e->getMessage());
            $accept();
        }
    }

    /**
     * The C2B confirmation Safaricom posts once money has been received.
     *
     * Always answers Accept, including on an unexpected payload. The money
     * arrived, and failing the acknowledgement invites a duplicate retry rather
     * than recovering the payment.
     */
    public static function c2bConfirmation(Request $r): void
    {
        $accept = static fn() => Response::json(['ResultCode' => 0, 'ResultDesc' => 'Accept']);

        try {
            $body = $r->body() ?: [];

            $transId = $body['TransID'] ?? $body['TransId'] ?? null;
            $phone = trim((string) ($body['MSISDN'] ?? $body['PhoneNumber'] ?? ''));

            /*
             * TransAmount first, TransAmt second.
             *
             * Safaricom sends TransAmount. Reading only TransAmt parsed the amount
             * as zero, so every C2B payment was recorded with no value and the
             * contribution was silently worthless.
             */
            $amountRaw = $body['TransAmount'] ?? $body['TransAmt'] ?? $body['Amount'] ?? 0;
            $amount = is_numeric($amountRaw) ? (float) $amountRaw : 0.0;

            // Recorded so a C2B payment appears in the ledger trail rather than
            // only on Safaricom's own dashboard. A duplicate TransID updates
            // rather than fails, which is what a Safaricom retry should do.
            if ($transId !== null && $phone !== '' && $amount > 0) {
                Database::run(
                    <<<'SQL'
                        INSERT INTO mpesa_transactions
                          (transaction_id, phone, amount, reference, type, status, response_data)
                        VALUES (?, ?, ?, ?, 'c2b', 'success', ?)
                        ON DUPLICATE KEY UPDATE
                          status = 'success',
                          response_data = VALUES(response_data)
                        SQL,
                    [
                        $transId,
                        $phone,
                        $amount,
                        $body['BillRefNumber'] ?? $body['AccountReference'] ?? null,
                        json_encode($body),
                    ]
                );

                $recorded = self::recordSuccessfulPayment($amount, $transId, $phone, 'mpesa_c2b');

                if ($recorded['matched'] && empty($recorded['duplicate'])) {
                    Log::startup("[mpesa] C2B recorded contribution {$recorded['contributionId']} "
                        . "for member {$recorded['memberId']}");
                } elseif (empty($recorded['matched'])) {
                    Log::warn("[mpesa] C2B UNMATCHED payment: KES {$amount} from {$phone}, "
                        . "TransID {$transId} - {$recorded['reason']}");
                }
            }

            Log::startup('[mpesa] C2B confirmation: '
                . ($transId ?: '(no TransID)') . " {$phone} {$amount} "
                . ($body['ResultCode'] ?? ''));

            $accept();
        } catch (\Throwable $e) {
            Log::warn('C2B confirmation error: ' . $e->getMessage());
            $accept();
        }
    }

    /**
     * The C2B validation Safaricom posts before completing a paybill payment.
     *
     * Answers Accept for the same reason as the confirmation.
     */
    public static function c2bValidation(Request $r): void
    {
        try {
            $body = $r->body() ?: [];

            Log::startup('[mpesa] C2B validation: '
                . ($body['TransID'] ?? $body['TransId'] ?? '(no TransID)') . ' '
                . ($body['MSISDN'] ?? $body['PhoneNumber'] ?? '(no phone)') . ' '
                . ($body['TransAmount'] ?? $body['TransAmt'] ?? $body['Amount'] ?? '(no amount)'));

            Response::json(['ResultCode' => 0, 'ResultDesc' => 'Accept']);
        } catch (\Throwable $e) {
            Log::warn('C2B validation error: ' . $e->getMessage());
            Response::json(['ResultCode' => 0, 'ResultDesc' => 'Accept']);
        }
    }

    // -------------------------------------------------------------- helpers

    /**
     * Records a successful payment as a contribution and a ledger entry.
     *
     * Runs in a transaction: a contribution without its ledger entry would leave
     * the cash book out of balance, and a ledger entry without a contribution
     * would record money no member is credited for.
     *
     * Idempotent by receipt. Safaricom retries callbacks, and without this guard
     * a retry credits the member twice for one payment.
     *
     * Returns a summary for logging. Never throws: the callback must always
     * answer Safaricom with ResultCode 0, or Safaricom keeps retrying a payment
     * that has already been recorded.
     */
    public static function recordSuccessfulPayment(
        $amount,
        $mpesaReceipt,
        $phone,
        string $paymentMethod
    ): array {
        $memberPhone = Phone::toMemberPhone($phone);

        if ($memberPhone === null) {
            return ['matched' => false, 'reason' => 'Unusable phone number: ' . $phone];
        }

        $member = Database::one(
            "SELECT id, full_name, phone FROM members WHERE phone = ? AND status = 'active'",
            [$memberPhone]
        );

        if ($member === null) {
            return ['matched' => false, 'reason' => 'No active member with phone ' . $memberPhone];
        }

        // Already recorded? A retry must not credit the member twice.
        $existing = Database::one(
            'SELECT id FROM contributions WHERE reference_number = ?',
            [$mpesaReceipt]
        );

        if ($existing !== null) {
            return [
                'matched' => true,
                'memberId' => $member['id'],
                'duplicate' => true,
                'contributionId' => $existing['id'],
            ];
        }

        $kind = $paymentMethod === 'mpesa_c2b' ? 'C2B' : 'STK push';

        $contributionId = Database::transaction(function ($pdo) use (
            $member, $amount, $paymentMethod, $mpesaReceipt, $kind
        ) {
            $statement = $pdo->prepare(
                <<<'SQL'
                    INSERT INTO contributions
                      (member_id, amount, contribution_date, payment_method,
                       reference_number, status, remarks, recorded_by)
                    VALUES (?, ?, CURDATE(), ?, ?, 'confirmed', ?, NULL)
                    SQL
            );
            $statement->execute([
                $member['id'],
                $amount,
                $paymentMethod,
                $mpesaReceipt,
                "M-Pesa {$kind}, receipt {$mpesaReceipt}",
            ]);

            $id = (int) $pdo->lastInsertId();

            $pdo->prepare(
                <<<'SQL'
                    INSERT INTO ledger_entries
                      (direction, category, description, amount, entry_date,
                       payment_method, reference_number, member_id, recorded_by)
                    VALUES ('in', 'Contribution', ?, ?, CURDATE(), ?, ?, ?, NULL)
                    SQL
            )->execute([
                'M-Pesa contribution from ' . $member['full_name'],
                $amount,
                $paymentMethod,
                $mpesaReceipt,
                $member['id'],
            ]);

            return $id;
        });

        // Notify the member. A payment they made should never need them to go
        // looking for it.
        Notifier::dispatch(
            'sms',
            (string) $member['phone'],
            'Your M-Pesa payment of KES ' . number_format((float) $amount, 0)
            . ' has been received. Receipt ' . $mpesaReceipt . '. Thank you.'
        );

        return [
            'matched' => true,
            'memberId' => $member['id'],
            'contributionId' => $contributionId,
        ];
    }

    /**
     * Fetches a Daraja access token.
     *
     * Throws DarajaException, which carries the machine code and a hint: a
     * rejection here is a Daraja configuration problem, and reporting it as a
     * server error sends the operator looking in the wrong place.
     */
    private static function accessToken(array $config): string
    {
        $auth = base64_encode($config['consumerKey'] . ':' . $config['consumerSecret']);

        $response = self::http('GET', MpesaConfig::baseUrl($config)
            . '/oauth/v1/generate?grant_type=client_credentials', null, [
                'Authorization: Basic ' . $auth,
            ]);

        return (string) ($response['access_token'] ?? '');
    }

    /**
     * Sends one STK Push request to Daraja.
     *
     * Split out from the route handlers so the same call can be made from the
     * test button in Settings. Duplicating the payload would mean a fix applied
     * in one place silently not applying to the other, and the test button is
     * only useful if it exercises the identical request a real payment makes.
     */
    private static function sendStkPrompt(array $config, array $input): array
    {
        /*
         * The timestamp Daraja expects: YYYYMMDDHHMMSS, UTC, no separators.
         *
         * Computed in UTC rather than local time. Daraja validates the window
         * against its own clock, so a server whose timezone is ahead would send a
         * timestamp from the future and be rejected as expired.
         */
        $timestamp = gmdate('YmdHis');

        $password = base64_encode($config['shortcode'] . $config['passkey'] . $timestamp);

        return self::daraja('POST', $config, '/mpesa/stkpush/v1/processrequest', [
            'BusinessShortCode' => $config['shortcode'],
            'Password' => $password,
            'Timestamp' => $timestamp,
            'TransactionType' => 'CustomerPayBillOnline',
            'Amount' => $input['amount'],
            'PartyA' => $input['phone'],
            'PartyB' => $config['shortcode'],
            'PhoneNumber' => $input['phone'],
            'CallBackURL' => $config['callbackUrl'],
            'AccountReference' => $input['reference'] ?: ($config['paybill'] ?: 'THE_TEAM'),
            'TransactionDesc' => $input['description']
                ?: (($config['paybill'] ?: 'Chama') . ' Contribution'),
        ], $input['accessToken']);
    }

    /** POSTs to Daraja with a bearer token. */
    private static function daraja(string $method, array $config, string $path, array $payload, string $token): array
    {
        return self::http(
            $method,
            MpesaConfig::baseUrl($config) . $path,
            $payload,
            ['Authorization: Bearer ' . $token]
        );
    }

    /**
     * One HTTPS request to Safaricom.
     *
     * Written against cURL directly rather than a client library, because the
     * only things needed are a JSON body, a few headers, a timeout and the
     * response body - including on failure, which is where the useful machine
     * code lives.
     *
     * @throws DarajaException on any failure, carrying whatever Daraja said
     */
    private static function http(string $method, string $url, ?array $payload, array $headers): array
    {
        $handle = curl_init($url);

        if ($handle === false) {
            throw new DarajaException(self::explain(null), 'Could not initialise a request.');
        }

        $responseHeaders = [];

        curl_setopt_array($handle, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_TIMEOUT => self::TIMEOUT_SECONDS,
            CURLOPT_CONNECTTIMEOUT => 10,

            // Daraja sends a redirect during token generation; following it to a
            // host we did not choose is how a bearer token ends up somewhere it
            // should not.
            CURLOPT_FOLLOWLOCATION => false,

            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,

            CURLOPT_HTTPHEADER => array_merge(['Content-Type: application/json', 'Accept: application/json'], $headers),

            CURLOPT_HEADERFUNCTION => static function ($ch, $line) use (&$responseHeaders) {
                $responseHeaders[] = trim($line);
                return strlen($line);
            },
        ]);

        if ($payload !== null) {
            curl_setopt($handle, CURLOPT_POSTFIELDS, json_encode($payload));
        }

        $body = curl_exec($handle);
        $error = curl_error($handle);
        $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
        curl_close($handle);

        $decoded = is_string($body) ? json_decode($body, true) : null;

        if ($body === false || !is_array($decoded)) {
            // No usable JSON. Either the network failed or Daraja answered with
            // something that is not Daraja - a proxy error page, most often.
            throw new DarajaException(
                self::explain(is_array($decoded) ? $decoded : null),
                $error !== '' ? $error : ('HTTP ' . $status . ' with an unreadable body')
            );
        }

        if ($status < 200 || $status >= 300) {
            throw new DarajaException(self::explain($decoded), 'Daraja returned HTTP ' . $status);
        }

        return $decoded;
    }

    /**
     * Turns a Daraja rejection into something an operator can act on.
     *
     * Daraja's machine code is far more useful than the HTTP status, and the
     * hints exist because most rejections are configuration on Daraja's side
     * rather than anything wrong here.
     */
    public static function explain(?array $data): array
    {
        $code = isset($data['errorCode']) ? (string) $data['errorCode'] : null;
        $message = isset($data['errorMessage']) ? (string) $data['errorMessage'] : null;

        $hints = [
            /*
             * By far the most common one, and the most misleading.
             *
             * Daraja answers "Invalid Access Token" here, which reads like a
             * credential problem. It is not: the token was just issued
             * successfully, so the consumer key and secret are correct. What is
             * missing is the STK Push endpoint on that key.
             *
             * Saying so explicitly matters. Otherwise the natural reaction is to
             * re-copy the key and secret, re-paste them into Settings and retry -
             * which changes nothing and hides the one step that would fix it.
             */
            '404.001.03' =>
                'Your credentials are correct - Safaricom accepted them and issued a token. What '
                . 'is missing is this one endpoint on your app. Open developer.safaricom.co.ke, '
                . 'select your app, go to "URLs", and add '
                . 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest under '
                . '"Initiate Customer M-PESA Transaction". Use the sandbox URL above for a sandbox '
                . 'key, or https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest for a live '
                . 'key. No need to change the consumer key, secret or passkey.',
            '400.002.03' => 'The Initiate Customer M-PESA Transaction URL is not registered on this app.',
            '400.002.06' => 'Invalid consumer key or secret. Re-copy them from the Daraja portal.',
            '400.002.31' =>
                'The passkey does not belong to this consumer key. Copy the passkey from the same '
                . 'app as the consumer key.',
            '400.002.26' => 'The Initiate Customer M-PESA Transaction URL is missing from the app.',
            '400.002.32' =>
                'Request rejected by business rules - often an unactivated or unconfigured paybill.',
            '400.003.03' => 'Invalid phone number. Use the international form, e.g. 254712345678.',
            '400.002.24' =>
                'The CallBackURL is not a valid URL. It must be a real, reachable https address, and '
                . 'Safaricom cannot reach localhost.',
            '400.001.07' => 'The passkey is wrong for this shortcode.',
        ];

        return [
            'daraja_code' => $code,
            'daraja_message' => $message,
            'hint' => ($code !== null && isset($hints[$code])) ? $hints[$code] : null,
        ];
    }

    /**
     * Hides most of a value.
     *
     * The consumer key is an identifier rather than a secret, but there is no
     * reason for the browser to hold it in full - and an operator who recognises
     * the first four characters can confirm at a glance that the key they typed
     * is the one in use.
     */
    private static function mask($value): string
    {
        $text = (string) $value;

        if (strlen($text) <= 6) {
            return substr($text, 0, 1) . '***';
        }

        return substr($text, 0, 4) . '***' . substr($text, -2);
    }
}

/**
 * A Daraja rejection.
 *
 * Carries the machine code, the message and any hint, so the controller can
 * report what Safaricom actually said rather than "something went wrong".
 */
final class DarajaException extends \RuntimeException
{
    public function __construct(public array $detail, string $message = '')
    {
        parent::__construct($message !== '' ? $message : ($detail['daraja_message'] ?? 'Daraja request failed'));
    }
}