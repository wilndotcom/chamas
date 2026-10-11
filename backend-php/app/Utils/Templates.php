<?php

declare(strict_types=1);

namespace TheTeam\Utils;

/**
 * Message templates and the tokens they may contain.
 *
 * A port of backend/utils/templates.js.
 *
 * Templates are editable: each is stored in settings under a tpl_ prefixed key so
 * a committee can reword one without a code change. The defaults here are what an
 * unset template falls back to.
 *
 * The token list is the contract with whoever writes the message. A token that is
 * not in this list renders literally as "{{typo}}" and reaches a member, which is
 * why unknownTokens exists and why the preview reports them.
 */
final class Templates
{
    /**
     * Every token a template may use.
     *
     * Each carries an example, because the Settings editor shows one - a token
     * list of bare names is not enough to write a sensible message against.
     */
    public const PLACEHOLDERS = [
        ['token' => '{{member_name}}', 'label' => 'Member name', 'example' => 'Achieng Odhiambo'],
        ['token' => '{{chama_name}}', 'label' => 'Chama name', 'example' => 'THE TEAM'],
        ['token' => '{{phone}}', 'label' => 'Member phone', 'example' => '0712345678'],
        ['token' => '{{email}}', 'label' => 'Member email', 'example' => 'achieng@example.com'],
        ['token' => '{{monthly_contribution}}', 'label' => 'Monthly contribution', 'example' => '1000'],
        ['token' => '{{reminder_day}}', 'label' => 'Reminder day', 'example' => '5'],
        ['token' => '{{paybill}}', 'label' => 'M-Pesa paybill', 'example' => '600000'],
        ['token' => '{{loan_amount}}', 'label' => 'Loan principal', 'example' => '10000'],
        ['token' => '{{balance}}', 'label' => 'Outstanding balance', 'example' => '5500'],
        ['token' => '{{amount_due}}', 'label' => 'Amount due now', 'example' => '5500'],
        ['token' => '{{total_repayable}}', 'label' => 'Total repayable', 'example' => '11000'],
        ['token' => '{{interest}}', 'label' => 'Interest amount', 'example' => '1000'],
        ['token' => '{{interest_rate}}', 'label' => 'Interest rate %', 'example' => '10'],
        ['token' => '{{due_date}}', 'label' => 'Loan due date', 'example' => '15 Jan 2027'],
        ['token' => '{{days_left}}', 'label' => 'Days until due', 'example' => '3'],
        ['token' => '{{application_date}}', 'label' => 'Loan applied on', 'example' => '4 Oct 2026'],
        ['token' => '{{loan_status}}', 'label' => 'Loan status', 'example' => 'pending'],
    ];

    /**
     * Sample values, for previewing a template before anybody receives it.
     *
     * Fixed rather than taken from a real member: a preview must never expose
     * somebody's balance or phone number to whoever happens to open the editor.
     */
    public const SAMPLE_DATA = [
        'member_name' => 'Achieng Odhiambo',
        'chama_name' => 'THE TEAM',
        'phone' => '0712345678',
        'email' => 'achieng@example.com',
        'monthly_contribution' => '1000',
        'reminder_day' => '5',
        'paybill' => '600000',
        'loan_amount' => '10000',
        'balance' => '5500',
        'amount_due' => '5500',
        'total_repayable' => '11000',
        'interest' => '1000',
        'interest_rate' => '10',
        'due_date' => '15 Jan 2027',
        'days_left' => '3',
        'application_date' => '4 Oct 2026',
        'loan_status' => 'pending',
    ];

    /** The built-in templates, and their defaults. */
    public const TEMPLATES = [
        [
            'key' => 'tpl_account_created',
            'label' => 'Account created',
            'description' => 'Sent to a member once an admin approves their registration.',
            'default' => 'Hello {{member_name}}, your {{chama_name}} membership has been approved. '
                . 'You can now log in with {{phone}}. Your monthly contribution is '
                . 'KES {{monthly_contribution}}, payable by the {{reminder_day}} of each month.',
        ],
        [
            'key' => 'tpl_welcome',
            'label' => 'Welcome message',
            'description' => 'Sent after approval to welcome the member and explain how to pay.',
            'default' => 'Welcome to {{chama_name}}, {{member_name}}! We are glad to have you. '
                . 'Please pay your monthly contribution of KES {{monthly_contribution}} by the '
                . '{{reminder_day}} of every month using M-Pesa paybill {{paybill}}. '
                . 'Kindly confirm receipt with the treasurer.',
        ],
        [
            'key' => 'tpl_loan_due',
            'label' => 'Loan due date',
            'description' => 'Sent on the due date itself.',
            'default' => '{{member_name}}, your {{chama_name}} loan of KES {{balance}} falls due '
                . 'today, {{due_date}}. Please pay KES {{amount_due}} on time. Thank you.',
        ],
        [
            'key' => 'tpl_due_7days',
            'label' => '7 days before due date',
            'description' => 'Early warning so the member can plan.',
            'default' => 'Reminder: {{member_name}}, your loan of KES {{balance}} is due in 7 days '
                . 'on {{due_date}}. Please begin arranging KES {{amount_due}}.',
        ],
        [
            'key' => 'tpl_due_3days',
            'label' => '3 days before due date',
            'description' => 'Second and more urgent reminder.',
            'default' => 'Final reminder: {{member_name}}, your {{chama_name}} loan of KES '
                . '{{balance}} is due in 3 days on {{due_date}}. Outstanding amount is '
                . 'KES {{amount_due}}.',
        ],
        [
            'key' => 'tpl_due_1day',
            'label' => '1 day before due date',
            'description' => 'Last call before the due date passes.',
            'default' => '{{member_name}}, your loan of KES {{balance}} is due tomorrow, '
                . '{{due_date}}. Please pay KES {{amount_due}} to avoid late consequences.',
        ],
        [
            'key' => 'tpl_loan_approved',
            'label' => 'Loan approved',
            'description' => 'Sent when the committee approves an application.',
            'default' => 'Good news {{member_name}}, your {{chama_name}} loan of KES '
                . '{{loan_amount}} has been approved. Interest is KES {{interest}} at '
                . '{{interest_rate}}%, making KES {{total_repayable}} repayable in full.',
        ],
        [
            'key' => 'tpl_loan_rejected',
            'label' => 'Loan declined',
            'description' => 'Sent when an application is not approved.',
            'default' => '{{member_name}}, your loan application of KES {{loan_amount}} was not '
                . 'approved this time. Please speak to the committee if you would like to discuss it.',
        ],
        [
            'key' => 'tpl_meeting_notice',
            'label' => 'Meeting notice',
            'description' => 'Sent to announce the next meeting.',
            'default' => '{{chama_name}} members: the next meeting is on {{due_date}}. '
                . 'Kindly attend. Contact the office on {{phone}} if you cannot make it.',
        ],
        [
            'key' => 'tpl_welfare_approved',
            'label' => 'Welfare approved',
            'description' => 'Sent when a welfare request is approved.',
            'default' => '{{member_name}}, your {{chama_name}} welfare request has been approved. '
                . 'It will be paid out shortly. Thank you.',
        ],
        [
            'key' => 'tpl_welfare_paid',
            'label' => 'Welfare paid',
            'description' => 'Sent when a welfare request has been paid out.',
            'default' => '{{member_name}}, your {{chama_name}} welfare payment has been sent. '
                . 'Thank you, and we hope things improve for you.',
        ],
        [
            'key' => 'tpl_contribution_reminder',
            'label' => 'Contribution reminder',
            'description' => 'Sent to a member who has not contributed this month.',
            'default' => 'Dear {{member_name}}, this is a friendly reminder that your contribution '
                . 'for this month (KES {{monthly_contribution}}) has not been received. '
                . 'Kindly pay via M-Pesa paybill {{paybill}}. Thank you.',
        ],
    ];

    /** Every template's default body, keyed by template key. */
    public static function defaults(): array
    {
        $defaults = [];

        foreach (self::TEMPLATES as $template) {
            $defaults[$template['key']] = $template['default'];
        }

        return $defaults;
    }

    /**
     * Substitutes tokens into a body.
     *
     * Simple strtr over the whole map rather than a regex, so a token whose value
     * happens to contain "{{phone}}" is not replaced a second time.
     */
    public static function render(string $body, array $data): string
    {
        return strtr($body, $data);
    }

    /**
     * Tokens in a body that are not in the known list.
     *
     * Returned so the preview can report them before a message goes to a real
     * member. Left in, "{{monthly_contribtion}}" reaches the recipient as itself.
     */
    public static function unknownTokens(string $body): array
    {
        preg_match_all('/\{\{\s*([a-z0-9_]+)\s*\}\}/i', $body, $matches);

        $known = array_column(self::PLACEHOLDERS, 'token');
        $known = array_map(
            static fn(string $t) => trim($t, '{}'),
            $known
        );

        $unknown = [];

        foreach ($matches[1] as $name) {
            if (!in_array($name, $known, true) && !in_array($name, $unknown, true)) {
                $unknown[] = $name;
            }
        }

        return $unknown;
    }

    /** Every known token name, without the braces. */
    public static function knownTokenNames(): array
    {
        return array_map(
            static fn(array $p) => trim($p['token'], '{}'),
            self::PLACEHOLDERS
        );
    }
}