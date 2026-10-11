<?php

declare(strict_types=1);

namespace TheTeam\Utils;

/**
 * Settings: which keys exist, what they may contain, and which are secret.
 *
 * A port of the rules at the top of backend/controllers/settingsController.js.
 *
 * Roles and permissions live in their own tables and are not settings at all, so
 * they are not on the editable list. The list is an allowlist rather than a
 * blocklist on purpose: a new table added later must be refused here until
 * somebody decides it should be editable, rather than becoming writable the
 * moment it appears.
 */
final class SettingsSchema
{
    /** What a read returns in place of a stored secret. */
    public const SECRET_MASK = '__saved__';

    /**
     * What a write may send to mean "leave this alone".
     *
     * This exists because Settings saves a whole card at once. If a read returned
     * a masked value and the screen sent it back untouched, the stored secret
     * would be overwritten with the mask and M-Pesa would break for every
     * operator who touched an unrelated field on the same card.
     *
     * Empty is NOT used for this, because empty already means "clear this",
     * which an operator must remain able to do.
     */
    public const KEEP_SENTINEL = '__keep__';

    /**
     * Keys a client may change through the settings screen.
     *
     * `theme` and `color_mode` are the shared look behind Appearance. They were
     * missing while the screen offered to save them, which made "save for
     * everyone" fail with "theme cannot be changed from here".
     */
    public const EDITABLE = [
        'chama_name',
        'monthly_contribution',
        'welfare_contribution',
        'loan_interest_rate',
        'loan_duration_months',
        'max_loan_multiplier',
        'language',
        'currency',
        'currency_symbol',
        'symbol_position',
        'decimal_separator',
        'thousand_separator',
        'theme',
        'color_mode',
        'mpesa_paybill',
        'mpesa_shortcode',
        'mpesa_consumer_key',
        'mpesa_consumer_secret',
        'mpesa_passkey',
        'mpesa_callback_url',
        'mpesa_environment',
        'airtel_environment',
        'airtel_api_key',
        'airtel_api_password',
        'airtel_api_username',
        'airtel_merchant_id',
        'airtel_service_provider_id',
        'email_from',

        // Notification channels (migration 014).
        // sms_api_key was already listed here and still did nothing, because the
        // notifier read the environment exclusively. Everything below is what the
        // dispatcher actually consults now.
        'sms_provider',
        'whatsapp_provider',
        'sms_username',
        'sms_api_key',
        'sms_sender_id',
        'twilio_account_sid',
        'twilio_auth_token',
        'twilio_sms_from',
        'twilio_whatsapp_number',
        'email_host',
        'email_port',
        'email_user',
        'email_pass',

        // Welfare rules (migration 016). Group decisions rather than constants,
        // so the committee can change them without a code change.
        'welfare_enabled',
        'welfare_allow_self_contribution',
        'welfare_request_needs_approval',
        'welfare_max_request_amount',
        'welfare_min_months_contributed',

        // On/off switches, separate from having credentials. An operator can hold
        // a working key and still want SMS switched off, and conflating the two
        // makes "saved the key but nothing sends" impossible to diagnose.
        'channel_sms_enabled',
        'channel_whatsapp_enabled',
        'channel_email_enabled',
    ];

    /**
     * Settings holding a live third-party credential.
     *
     * Read with system_settings and returned in full by getAllSettings, which
     * made the Daraja consumer secret and STK passkey readable over one GET. The
     * consumer key is included even though Safaricom treats it as an identifier:
     * it is half of the pair that authorises money movement, and there is no
     * reason for the browser to hold it.
     */
    public const SECRET_KEYS = [
        'mpesa_consumer_key',
        'mpesa_consumer_secret',
        'mpesa_passkey',
        'airtel_api_key',
        'airtel_api_password',
        // Notification channel credentials. Each one authorises sending to real
        // phone numbers at the operator's expense.
        'sms_api_key',
        'twilio_auth_token',
        'twilio_account_sid',
        'email_pass',
    ];

    /**
     * Closed sets, for values the interface offers as a fixed list.
     *
     * The skin list mirrors the `[data-theme='...']` blocks in index.css and the
     * THEMES array in ThemeContext.jsx. The frontend already falls back to a
     * default for anything unrecognised, but storing the bad value would report
     * a successful save while quietly showing something else, so it is rejected
     * here instead.
     */
    public static function allowedValues(): array
    {
        return array_merge([
            'theme' => ['emerald', 'ocean', 'sunset', 'forest', 'plum', 'slate'],
            'color_mode' => ['light', 'dark'],

            // A closed set on purpose. Anything else here would be passed to
            // Safaricom as the base URL, and a typo must not resolve to the live
            // endpoint by accident.
            'mpesa_environment' => ['sandbox', 'production'],
            'airtel_environment' => ['sandbox', 'production'],

            // The channel switches. Stored as 0/1 so the column stays a single
            // character, and closed so nothing else can arrive in it and be read
            // as truthy.
            'channel_sms_enabled' => ['0', '1'],
            'channel_whatsapp_enabled' => ['0', '1'],
            'channel_email_enabled' => ['0', '1'],

            // Welfare switches, same convention.
            'welfare_enabled' => ['0', '1'],
            'welfare_allow_self_contribution' => ['0', '1'],
            'welfare_request_needs_approval' => ['0', '1'],

            // The custom provider's fixed choices. Closed so a typo cannot be
            // stored and then silently treated as the default at send time.
            'sms_provider' => ['africas_talking', 'twilio', 'custom'],
            'whatsapp_provider' => ['twilio', 'custom'],
        ], self::customProviderValues());
    }

    /** Keys for one channel's custom HTTP provider. Shared with the frontend shape. */
    public static function customKeys(string $channel): array
    {
        return array_map(
            static fn(string $suffix): string => "custom_{$channel}_{$suffix}",
            ['endpoint', 'method', 'auth_type', 'auth_header', 'auth_value', 'username',
             'password', 'body', 'phone_format', 'sender']
        );
    }

    /**
     * The custom provider keys, editable and closed-set.
     *
     * Built rather than listed by hand: twenty keys follow one pattern across
     * two channels, and listing them by hand is how one gets missed and saves as
     * a rejected field with no obvious cause.
     */
    private static function customProviderValues(): array
    {
        $values = [];

        foreach (['sms', 'whatsapp'] as $channel) {
            $values["custom_{$channel}_method"] = ['POST', 'PUT'];
            $values["custom_{$channel}_auth_type"] = ['none', 'bearer', 'header', 'basic'];
            $values["custom_{$channel}_phone_format"] = ['254', '+254'];
        }

        return $values;
    }

    /** Every editable key, including the generated custom-provider ones. */
    public static function editableKeys(): array
    {
        $keys = self::EDITABLE;

        foreach (['sms', 'whatsapp'] as $channel) {
            $keys = array_merge($keys, self::customKeys($channel));
        }

        return $keys;
    }

    /** Every secret key, including the custom-provider credentials. */
    public static function secretKeys(): array
    {
        $keys = self::SECRET_KEYS;

        foreach (['sms', 'whatsapp'] as $channel) {
            $keys[] = "custom_{$channel}_auth_value";
            $keys[] = "custom_{$channel}_password";
        }

        return $keys;
    }

    public static function isEditable(string $key): bool
    {
        return in_array($key, self::editableKeys(), true);
    }

    public static function isSecret(string $key): bool
    {
        return in_array($key, self::secretKeys(), true);
    }

    /**
     * Friendly names, so a validation error reads as "Loan interest rate must be
     * between 0 and 100." rather than repeating the raw column name.
     */
    public static function label(string $key): string
    {
        return [
            'loan_interest_rate' => 'Loan interest rate',
            'loan_duration_months' => 'Loan duration',
            'max_loan_multiplier' => 'Max loan multiplier',
            'monthly_contribution' => 'Monthly contribution',
            'welfare_contribution' => 'Welfare contribution',
            'theme' => 'Colour skin',
            'color_mode' => 'Colour mode',
            'mpesa_environment' => 'M-Pesa environment',
            'airtel_environment' => 'Airtel Money environment',
            'sms_provider' => 'SMS provider',
            'whatsapp_provider' => 'WhatsApp provider',
            'sms_username' => "Africa's Talking username",
            'sms_api_key' => "Africa's Talking API key",
            'sms_sender_id' => "Africa's Talking sender id",
            'twilio_account_sid' => 'Twilio Account SID',
            'twilio_auth_token' => 'Twilio Auth Token',
            'twilio_sms_from' => 'Twilio SMS sender',
            'twilio_whatsapp_number' => 'Twilio WhatsApp sender',
            'email_host' => 'SMTP host',
            'email_port' => 'SMTP port',
            'email_user' => 'SMTP username',
            'email_pass' => 'SMTP password',
            'channel_sms_enabled' => 'SMS channel',
            'channel_whatsapp_enabled' => 'WhatsApp channel',
            'channel_email_enabled' => 'Email channel',
            'airtel_api_key' => 'Airtel Money API key',
            'airtel_api_password' => 'Airtel Money API password',
            'airtel_api_username' => 'Airtel Money API username',
            'airtel_merchant_id' => 'Airtel Money merchant id',
            'airtel_service_provider_id' => 'Airtel Money service provider id',
        ][$key] ?? $key;
    }

    /**
     * Numeric ranges.
     *
     * Zero is meaningful for the two welfare rules - "no cap" and "no waiting
     * period". They are allowed at zero rather than rejected as out of range,
     * which would make "unlimited" unreachable and force the committee to invent
     * a fake limit.
     */
    public static function numericRules(): array
    {
        return [
            // Interest is a flat percentage charged on the principal.
            'loan_interest_rate' => ['min' => 0, 'max' => 100],
            'loan_duration_months' => ['min' => 1, 'max' => 60, 'integer' => true],
            'max_loan_multiplier' => ['min' => 1, 'max' => 100],
            'monthly_contribution' => ['min' => 0, 'max' => 100000000, 'allowDecimal' => true],
            'welfare_contribution' => ['min' => 0, 'max' => 100000000, 'allowDecimal' => true],
            'welfare_max_request_amount' => ['min' => 0, 'max' => 100000000, 'allowDecimal' => true],
            'welfare_min_months_contributed' => ['min' => 0, 'max' => 600, 'integer' => true],
        ];
    }

    /** True when a value is one of the sentinels rather than real input. */
    public static function isSentinel(string $value): bool
    {
        return $value === self::KEEP_SENTINEL || $value === self::SECRET_MASK;
    }

    /**
     * Rejects a custom endpoint that points at this machine or a private network.
     *
     * Checked on save rather than only at send, so the Settings screen refuses it
     * while the operator is looking at the field. Sending from a treasurer's
     * screen to the server's own internal endpoints is not something to leave
     * open.
     *
     * @return string|null The problem, or null when the address is acceptable
     */
    public static function validateCustomEndpoint(string $key, string $raw): ?string
    {
        // Unset is handled by the "configured" check, not here.
        if ($raw === '') {
            return null;
        }

        $url = parse_url(trim($raw));

        if ($url === false || !isset($url['host'])) {
            return "{$key} is not a valid URL.";
        }

        $scheme = strtolower($url['scheme'] ?? '');
        if (!in_array($scheme, ['http', 'https'], true)) {
            return "{$key} must start with http:// or https://.";
        }

        if (self::isPrivateHost($url['host'])) {
            return sprintf(
                '%s points at this machine or a private network address (%s), which cannot be a '
                . 'payment gateway. Use the public https address your provider gave you.',
                $key,
                $url['host']
            );
        }

        return null;
    }

    /**
     * Whether a host is this machine or something inside the network.
     *
     * Written as explicit cases rather than a single pattern, because the
     * judgement is about what each address *means*, and the reason is worth
     * reading next to the check. Note that this is a first filter, not a
     * complete defence: a hostname can resolve to a private address, so the
     * notifier also refuses to follow redirects and re-checks at send time.
     */
    private static function isPrivateHost(string $host): bool
    {
        $host = strtolower(trim($host, '[]'));

        if ($host === 'localhost' || str_ends_with($host, '.localhost')) {
            return true;
        }

        // Cloud metadata endpoints. Reachable from an app server on a major cloud
        // and returns credentials for the machine it runs on.
        if (str_starts_with($host, 'metadata.') || $host === 'metadata') {
            return true;
        }

        // Kubernetes and other internal service discovery.
        if (str_ends_with($host, '.internal') || str_ends_with($host, '.local')) {
            return true;
        }

        // IPv6 loopback and unspecified.
        if ($host === '::1' || $host === '0:0:0:0:0:0:0:1') {
            return true;
        }

        if (filter_var($host, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6) !== false) {
            // fc00::/7 is unique-local, fe80::/10 is link-local.
            $packed = @inet_pton($host);
            if ($packed === false) {
                return true;
            }
            $first = ord($packed[0]);
            return $first === 0xFC || $first === 0xFD || ($first === 0xFE && (ord($packed[1]) & 0xC0) === 0x80);
        }

        if (filter_var($host, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) === false) {
            // Not an address, so it is a name. Assume it is fine; a name that
            // resolves inward is caught at send time.
            return false;
        }

        $long = ip2long($host);
        if ($long === false) {
            return true;
        }

        // 127.0.0.0/8 loopback
        if (($long >> 24) === 127) {
            return true;
        }
        // 0.0.0.0/8 "this network"
        if (($long >> 24) === 0) {
            return true;
        }
        // 10.0.0.0/8
        if (($long >> 24) === 10) {
            return true;
        }
        // 172.16.0.0/12
        if ((($long >> 24) === 172) && ((($long >> 16) & 0xF0) === 16)) {
            return true;
        }
        // 192.168.0.0/16
        if ((($long >> 24) === 192) && ((($long >> 16) & 0xFF) === 168)) {
            return true;
        }
        // 169.254.0.0/16 link-local, which is where the cloud metadata lives
        if ((($long >> 24) === 169) && ((($long >> 16) & 0xFF) === 254)) {
            return true;
        }

        return false;
    }
}