const pool = require('../config/database');
const notifier = require('../utils/notifier');
const { getNotificationConfig } = require('../utils/notificationConfig');
const templates = require('../utils/templates');
const {
  findRiskMembers,
  buildReminderMessage,
  getSetting
} = require('../utils/riskMembers');

/**
 * Preview or send a test of one notification template.
 *
 * Rendering uses realistic sample values unless the caller overrides them, so
 * the admin sees exactly what a member would receive. `dry_run` (default true)
 * only renders, which lets the preview work before any provider exists.
 */
const testTemplate = async (req, res) => {
  try {
    const { template_key, channel, to, email, overrides, dry_run } = req.body;

    const definition = templates.TEMPLATES.find((t) => t.key === template_key);
    if (!definition) {
      return res.status(400).json({ error: 'Unknown template.' });
    }

    const [rows] = await pool.execute(
      'SELECT setting_value FROM settings WHERE setting_key = ?',
      [template_key]
    );
    const body = rows.length ? rows[0].setting_value : definition.default;

    const data = { ...templates.sampleData, ...(overrides || {}) };
    const rendered = templates.render(body, data);
    const unknown = templates.unknownTokens(body);

    const targetChannel = String(channel || 'sms').toLowerCase();
    const valid = ['sms', 'whatsapp', 'email', 'in_app'];
    if (!valid.includes(targetChannel)) {
      return res.status(400).json({ error: `Channel must be one of: ${valid.join(', ')}` });
    }

    const response = {
      template_key,
      label: definition.label,
      channel: targetChannel,
      raw: body,
      rendered,
      unknown_placeholders: unknown
    };

    // Preview only: stop before any delivery attempt.
    if (dry_run !== false) {
      return res.json({ ...response, dry_run: true });
    }

    if (!to && targetChannel !== 'in_app') {
      return res.status(400).json({ error: 'A phone number is required to send a test.' });
    }

    const outcome = await notifier.dispatch(targetChannel, {
      to,
      email: email || data.email,
      subject: `${definition.label} (test)`,
      message: rendered
    });

    if (outcome.success) {
      await pool.execute(
        `INSERT INTO notifications (member_id, admin_id, type, category, subject, message, status, sent_at)
         VALUES (NULL, ?, ?, 'general', ?, ?, 'sent', NOW())`,
        [req.user.id, targetChannel, `${definition.label} (test)`, rendered]
      );
    }

    res.json({
      ...response,
      dry_run: false,
      delivery: {
        success: !!outcome.success,
        skipped: !!outcome.skipped,
        provider: outcome.provider || null,
        detail: outcome.error || outcome.reason || outcome.detail || null,
        sent_to: to || email || null
      }
    });
  } catch (error) {
    console.error('Test template error:', error);
    res.status(500).json({ error: 'Failed to test the template.' });
  }
};

/** Template metadata plus placeholder list, for the Settings editor. */
const getTemplateInfo = async (req, res) => {
  try {
    const [rows] = await pool.execute(
      "SELECT setting_key, setting_value FROM settings WHERE setting_key LIKE 'tpl_%'"
    );
    const stored = Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value]));

    res.json({
      placeholders: templates.PLACEHOLDERS,
      sample: templates.sampleData,
      templates: templates.TEMPLATES.map((t) => ({
        key: t.key,
        label: t.label,
        description: t.description,
        body: stored[t.key] ?? t.default,
        is_default: !(t.key in stored)
      }))
    });
  } catch (error) {
    console.error('Get template info error:', error);
    res.status(500).json({ error: 'Failed to load templates.' });
  }
};

// Get all notifications
const getAllNotifications = async (req, res) => {
  try {
    const [notifications] = await pool.execute(
      `SELECT n.*, m.full_name as member_name, a.full_name as admin_name
       FROM notifications n
       LEFT JOIN members m ON n.member_id = m.id
       LEFT JOIN admins a ON n.admin_id = a.id
       ORDER BY n.created_at DESC LIMIT 100`
    );
    res.json({ notifications });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch notifications.' });
  }
};

// Send notification to member
const sendNotification = async (req, res) => {
  try {
    const { member_id, type, category, subject, message } = req.body;

    if (!member_id || !type || !message) {
      return res.status(400).json({ error: 'Member, type, and message are required.' });
    }

    const [result] = await pool.execute(
      `INSERT INTO notifications (member_id, admin_id, type, category, subject, message, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [member_id, req.user.id, type, category || 'general', subject || null, message]
    );

    res.status(201).json({ success: true, notification_id: result.insertId, message: 'Notification queued.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to send notification.' });
  }
};

// Send bulk notification
const sendBulkNotification = async (req, res) => {
  try {
    const { member_ids, type, category, subject, message } = req.body;

    if (!member_ids || !Array.isArray(member_ids) || member_ids.length === 0) {
      return res.status(400).json({ error: 'Member IDs array is required.' });
    }

    const values = member_ids.map(mid => [mid, req.user.id, type, category || 'general', subject || null, message, 'pending']);

    await pool.query(
      `INSERT INTO notifications (member_id, admin_id, type, category, subject, message, status) VALUES ?`,
      [values]
    );

    res.json({ success: true, message: `Notification queued for ${member_ids.length} members.` });
  } catch (error) {
    res.status(500).json({ error: 'Failed to send bulk notification.' });
  }
};

// Get member notifications
const getMemberNotifications = async (req, res) => {
  try {
    const [notifications] = await pool.execute(
      `SELECT * FROM notifications WHERE member_id = ? ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json({ notifications });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch notifications.' });
  }
};

/**
 * Chases members who are behind.
 *
 * `member_ids` may be omitted, in which case everyone currently flagged as
 * behind is reminded. Each channel is attempted independently and the response
 * reports what actually happened, so a channel without credentials shows up as
 * skipped rather than sent.
 */
const sendReminders = async (req, res) => {
  try {
    const { member_ids, channels, include_loans } = req.body;

    const requested = Array.isArray(member_ids) && member_ids.length > 0
      ? member_ids.map(Number)
      : null;

    const targetChannels = (Array.isArray(channels) && channels.length
      ? channels
      : String(await getSetting('reminder_channels', 'sms')).split(',')
    )
      .map((c) => String(c).trim().toLowerCase())
      .filter((c) => ['sms', 'whatsapp', 'email', 'in_app'].includes(c));

    if (targetChannels.length === 0) {
      return res.status(400).json({ error: 'No valid channels selected.' });
    }

    const risk = await findRiskMembers();
    const chamaName = await getSetting('chama_name', 'THE TEAM');

    let targets = risk.members;
    if (requested) {
      targets = targets.filter((m) => requested.includes(m.member_id));
    } else if (include_loans === false) {
      // Contribution-only sweep, ignoring loan problems.
      targets = targets.filter((m) => m.reason !== 'overdue_loan' && m.reason !== 'defaulted_loan');
    }

    if (targets.length === 0) {
      return res.json({
        success: true,
        sent: 0,
        message: 'No members are currently behind.',
        results: []
      });
    }

    const results = [];

    for (const member of targets) {
      const message = buildReminderMessage(member, {
        chamaName,
        monthlyAmount: risk.monthlyAmount
      });
      const subject = `${chamaName}: payment reminder`;

      for (const channel of targetChannels) {
        const outcome = await notifier.dispatch(channel, {
          to: member.phone,
          email: member.email,
          subject,
          message
        });

        // 'skipped' means no provider is configured: record it as pending so the
        // gap is visible instead of being reported as a successful send.
        const status = outcome.success ? 'sent' : 'failed';

        const [result] = await pool.execute(
          `INSERT INTO notifications (member_id, admin_id, type, category, subject, message, status, sent_at)
           VALUES (?, ?, ?, 'reminder', ?, ?, ?, ${outcome.success ? 'NOW()' : 'NULL'})`,
          [member.member_id, req.user.id, channel, subject, message, status]
        );

        results.push({
          notification_id: result.insertId,
          member_id: member.member_id,
          member: member.full_name,
          channel,
          reason: member.reason,
          severity: member.severity,
          status,
          provider: outcome.provider || null,
          skipped: !!outcome.skipped,
          detail: outcome.error || outcome.reason || outcome.detail || null
        });
      }
    }

    const sent = results.filter((r) => r.status === 'sent').length;
    const skipped = results.filter((r) => r.skipped).length;
    const failed = results.filter((r) => r.status === 'failed' && !r.skipped).length;

    res.json({
      success: true,
      members_contacted: targets.length,
      sent,
      skipped,
      failed,
      message:
        sent > 0
          ? `Sent ${sent} reminder${sent === 1 ? '' : 's'}.`
          : 'Reminders recorded, but no delivery channel is configured yet.',
      results
    });
  } catch (error) {
    console.error('Send reminders error:', error);
    res.status(500).json({ error: 'Failed to send reminders.' });
  }
};

/**
 * What each delivery channel can currently do, and where its credentials came from.
 *
 * The Settings screen shows this instead of inferring status from whether fields
 * are filled in. The gap it closes is the one that made the old SMS key field
 * unusable: a credential could be saved, look correct, and still be ignored. Here
 * the answer is computed the same way the dispatcher computes it.
 *
 * Secret values are never echoed. Only whether one is present and which store it
 * came from, because "saved here" versus "still falling back to .env" is the
 * distinction an operator actually needs.
 */
const getChannelStatus = async (req, res) => {
  try {
    const cfg = await getNotificationConfig({ fresh: true });

    res.json({
      channels: cfg.channels,
      // Where each credential is coming from. Reported per key so a half-configured
      // channel shows which half is missing instead of "not configured".
      source: cfg.source,
      provider: {
        sms: cfg.smsProvider,
        whatsapp: cfg.whatsappProvider,
        email: 'smtp'
      },
      // Non-secret values the screen can display to confirm what is in use.
      effective: {
        sms_sender_id: cfg.at.senderId || null,
        twilio_sms_from: cfg.twilio.smsFrom || null,
        twilio_whatsapp_number: cfg.twilio.whatsappFrom || null,
        email_from: cfg.email.from || null,
        email_host: cfg.email.host || null,
        email_port: String(cfg.email.port)
      }
    });
  } catch (error) {
    console.error('Channel status error:', error);
    res.status(500).json({ error: 'Failed to read the notification channel settings.' });
  }
};

/**
 * Sends one real message to one number, so credentials can be verified before
 * they are relied on for a reminder to the whole group.
 *
 * Deliberately not routed through sendNotification: that writes a notification row
 * against a member and sends to a member's number, so testing credentials would
 * put a bogus message into a member's history. This sends only to the number
 * supplied, and records nothing.
 */
const testChannel = async (req, res) => {
  const { channel, phone, email } = req.body || {};

  if (!['sms', 'whatsapp', 'email'].includes(channel)) {
    return res.status(400).json({ error: 'Choose SMS, WhatsApp or email.' });
  }

  const target = channel === 'email' ? email : phone;
  if (!target) {
    return res
      .status(400)
      .json({ error: channel === 'email' ? 'An email address is required.' : 'A phone number is required.' });
  }

  // Says which number it will actually reach, before sending. A mistyped digit is
  // the most likely way to "test" the wrong person and then wonder why they got
  // a message from a chama they are not in.
  const preview = channel === 'email' ? target : notifier.normalisePhone(phone);
  if (channel !== 'email' && !preview) {
    return res.status(400).json({
      error:
        'That does not look like a Kenyan number. Use the international form, for example 254712345678.'
    });
  }

  try {
    const outcome = await notifier.dispatch(channel, {
      to: preview,
      email: target,
      subject: 'THE TEAM test message',
      message:
        `This is a test message from THE TEAM. If you received it, ${channel} notifications are working.`
    });

    // Nothing recorded: a test is not a notification and must not appear in the
    // history that admins read.
    res.json({
      success: !!outcome.success,
      skipped: !!outcome.skipped,
      provider: outcome.provider || null,
      sent_to: preview,
      detail: outcome.error || outcome.reason || outcome.detail || null
    });
  } catch (error) {
    console.error('Channel test error:', error);
    res.status(500).json({ error: 'The test message could not be sent.' });
  }
};

module.exports = {
  getAllNotifications,
  sendNotification,
  sendBulkNotification,
  getMemberNotifications,
  sendReminders,
  testTemplate,
  getTemplateInfo,
  getChannelStatus,
  testChannel
};
