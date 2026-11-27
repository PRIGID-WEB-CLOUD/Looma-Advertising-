import crypto from 'node:crypto';
import { createAppRouter, type AppRouter, type Response } from '../http/router';
import { AuthenticatedRequest, createAuthMiddleware, requireRole } from '../auth';
import { withTransaction, type DbClient } from '../db/postgres';
import { dispatchProviderPayout, queueTransactionalEmail } from '../security';
import { runScheduledJob, type ScheduledJobName } from '../jobs';
import { getFeatureFlags } from '../modules/featureFlags';
import { getOperationalMonitoringSnapshot } from '../modules/monitoring';
import {
  isPlainObject,
  validateNumberRange,
  validatePlatformSettingsInput,
  validateProhibitedCategoryInput,
  validateTextLength,
} from '../../src/lib/validation';

export function createAdminRouter(db: DbClient): AppRouter {
  const router = createAppRouter();
  const requireAuth = createAuthMiddleware(db);
  router.use(requireAuth, requireRole('admin'));

  // GET /api/admin/overview
  router.get('/overview', async (_req: AuthenticatedRequest, res: Response) => {
    const totals = (await db.queryOne<Record<string, number>>(
      `SELECT
         (SELECT COUNT(*) FROM advertiser_accounts) AS total_advertisers,
         (SELECT COUNT(*) FROM publisher_accounts) AS total_publishers,
         (SELECT COUNT(*) FROM campaigns WHERE status = 'active') AS active_campaigns,
         (SELECT COUNT(*) FROM impressions WHERE is_valid = 1) AS total_impressions,
         (SELECT COUNT(*) FROM clicks WHERE is_valid = 1) AS total_clicks,
         (SELECT COALESCE(SUM(lifetime_spent_micros), 0) FROM advertiser_wallets) AS total_ad_spend_micros,
         (SELECT COALESCE(SUM(available_micros), 0) FROM publisher_wallets) AS publisher_liabilities_micros,
         (SELECT COALESCE(SUM(amount_micros), 0) FROM withdrawals WHERE status = 'pending') AS pending_payouts_micros,
         (SELECT COUNT(*) FROM fraud_alerts WHERE status IN ('open', 'investigating')) AS open_fraud_alerts,
         (SELECT COUNT(*) FROM campaigns WHERE moderation_status = 'pending') AS pending_campaigns,
         (SELECT COUNT(*) FROM publisher_properties WHERE approval_status = 'pending') AS pending_properties`
    ))!;

    const platformRevRow = (await db.queryOne<{
      imp_fees: number;
      clk_fees: number;
      cnv_fees: number;
      seeded_rev: number;
    }>(
      `SELECT COALESCE(SUM(platform_fee_micros), 0) AS imp_fees,
              (SELECT COALESCE(SUM(platform_fee_micros), 0) FROM clicks WHERE is_valid = 1) AS clk_fees,
              (SELECT COALESCE(SUM(platform_fee_micros), 0) FROM conversions WHERE is_valid = 1) AS cnv_fees,
              (SELECT COALESCE(SUM(amount_micros), 0) FROM financial_ledger WHERE account_type = 'platform_revenue') AS seeded_rev
       FROM impressions WHERE is_valid = 1`
    ))!;

    const platformRevenueMicros =
      Number(platformRevRow.seeded_rev) +
      Number(platformRevRow.imp_fees) +
      Number(platformRevRow.clk_fees) +
      Number(platformRevRow.cnv_fees);

    res.json({
      overview: {
        ...totals,
        platform_revenue_micros: platformRevenueMicros,
      },
    });
  });

  // GET /api/admin/advertisers
  router.get('/advertisers', async (_req: AuthenticatedRequest, res: Response) => {
    const advertisers = await db.query(
      `SELECT a.*, u.email, u.full_name, w.available_micros, w.lifetime_deposited_micros, w.lifetime_spent_micros,
              (SELECT COUNT(*) FROM campaigns c WHERE c.advertiser_id = a.id) AS campaign_count
       FROM advertiser_accounts a
       JOIN users u ON u.id = a.user_id
       JOIN advertiser_wallets w ON w.advertiser_id = a.id
       ORDER BY a.created_at DESC`
    );
    res.json({ advertisers });
  });

  // PATCH /api/admin/advertisers/:id
  router.patch('/advertisers/:id', async (req: AuthenticatedRequest, res: Response) => {
    const { verificationStatus, accountStatus } = req.body ?? {};
    const advId = String(req.params.id);
    const existing = await db.queryOne('SELECT id FROM advertiser_accounts WHERE id = ?', [advId]);
    if (!existing) {
      res.status(404).json({ error: 'Advertiser not found' });
      return;
    }

    const fieldErrors: Record<string, string> = {};
    if (verificationStatus !== undefined && !['pending', 'verified', 'rejected'].includes(String(verificationStatus))) {
      fieldErrors.verificationStatus = 'verificationStatus must be pending, verified, or rejected.';
    }
    if (accountStatus !== undefined && !['active', 'suspended'].includes(String(accountStatus))) {
      fieldErrors.accountStatus = 'accountStatus must be active or suspended.';
    }
    if (verificationStatus === undefined && accountStatus === undefined) {
      fieldErrors.verificationStatus = 'Provide verificationStatus or accountStatus to update.';
    }
    const firstKey = Object.keys(fieldErrors)[0];
    if (firstKey) {
      res.status(400).json({ error: fieldErrors[firstKey], fieldErrors });
      return;
    }

    if (verificationStatus !== undefined) {
      await db.execute('UPDATE advertiser_accounts SET verification_status = ? WHERE id = ?', [
        String(verificationStatus),
        advId,
      ]);
    }
    if (accountStatus !== undefined) {
      await db.execute('UPDATE advertiser_accounts SET account_status = ? WHERE id = ?', [String(accountStatus), advId]);
    }

    await db.execute(
      `INSERT INTO audit_logs (id, actor_user_id, action, resource_type, resource_id, details_json)
       VALUES (?, ?, 'update_advertiser', 'advertiser_account', ?, ?)`,
      [
        `aud_${crypto.randomUUID().slice(0, 10)}`,
        req.auth!.userId,
        advId,
        JSON.stringify({ verificationStatus, accountStatus }),
      ]
    );

    res.json({ updated: true });
  });

  // GET /api/admin/publishers
  router.get('/publishers', async (_req: AuthenticatedRequest, res: Response) => {
    const publishers = await db.query(
      `SELECT p.*, u.email, u.full_name, w.available_micros, w.pending_micros, w.lifetime_earned_micros, w.invalid_deducted_micros
       FROM publisher_accounts p
       JOIN users u ON u.id = p.user_id
       JOIN publisher_wallets w ON w.publisher_id = p.id
       ORDER BY p.created_at DESC`
    );

    const properties = await db.query(
      `SELECT prop.*, pub.organization_name
       FROM publisher_properties prop
       JOIN publisher_accounts pub ON pub.id = prop.publisher_id
       ORDER BY prop.created_at DESC`
    );

    res.json({ publishers, properties });
  });

  // PATCH /api/admin/publishers/:id
  router.patch('/publishers/:id', async (req: AuthenticatedRequest, res: Response) => {
    const { approvalStatus, customRevenueShareBps } = req.body ?? {};
    const pubId = String(req.params.id);
    const existing = await db.queryOne('SELECT id FROM publisher_accounts WHERE id = ?', [pubId]);
    if (!existing) {
      res.status(404).json({ error: 'Publisher not found' });
      return;
    }

    const fieldErrors: Record<string, string> = {};
    if (approvalStatus !== undefined && !['pending', 'approved', 'suspended'].includes(String(approvalStatus))) {
      fieldErrors.approvalStatus = 'approvalStatus must be pending, approved, or suspended.';
    }
    let validatedBps: number | null | undefined;
    if (customRevenueShareBps !== undefined) {
      if (customRevenueShareBps === null) {
        validatedBps = null;
      } else {
        const bpsRes = validateNumberRange(customRevenueShareBps, {
          label: 'Custom revenue share (bps)',
          min: 1000,
          max: 9500,
          integer: true,
        });
        if (bpsRes.error) fieldErrors.customRevenueShareBps = bpsRes.error;
        else validatedBps = bpsRes.value;
      }
    }
    if (approvalStatus === undefined && customRevenueShareBps === undefined) {
      fieldErrors.approvalStatus = 'Provide approvalStatus or customRevenueShareBps to update.';
    }
    const firstKey = Object.keys(fieldErrors)[0];
    if (firstKey) {
      res.status(400).json({ error: fieldErrors[firstKey], fieldErrors });
      return;
    }

    if (approvalStatus !== undefined) {
      await db.execute('UPDATE publisher_accounts SET approval_status = ? WHERE id = ?', [String(approvalStatus), pubId]);
    }
    if (validatedBps !== undefined) {
      await db.execute('UPDATE publisher_accounts SET custom_revenue_share_bps = ? WHERE id = ?', [validatedBps, pubId]);
    }

    await db.execute(
      `INSERT INTO audit_logs (id, actor_user_id, action, resource_type, resource_id, details_json)
       VALUES (?, ?, 'update_publisher', 'publisher_account', ?, ?)`,
      [
        `aud_${crypto.randomUUID().slice(0, 10)}`,
        req.auth!.userId,
        pubId,
        JSON.stringify({ approvalStatus, customRevenueShareBps }),
      ]
    );

    res.json({ updated: true });
  });

  // PATCH /api/admin/properties/:id
  router.patch('/properties/:id', async (req: AuthenticatedRequest, res: Response) => {
    const propId = String(req.params.id);
    const { approvalStatus } = req.body ?? {};
    if (!['approved', 'rejected', 'pending'].includes(approvalStatus)) {
      res.status(400).json({ error: 'Invalid property approvalStatus' });
      return;
    }
    const resUpdate = await db.execute('UPDATE publisher_properties SET approval_status = ? WHERE id = ?', [
      String(approvalStatus),
      propId,
    ]);
    if (resUpdate.rowCount === 0) {
      res.status(404).json({ error: 'Property not found' });
      return;
    }

    await db.execute(
      `INSERT INTO moderation_reviews (id, target_type, target_id, reviewer_id, decision, reason)
       VALUES (?, 'property', ?, ?, ?, ?)`,
      [
        `mod_${crypto.randomUUID().slice(0, 10)}`,
        propId,
        req.auth!.userId,
        approvalStatus === 'approved' ? 'approved' : 'rejected',
        `Property ${approvalStatus} by platform operations`,
      ]
    );

    res.json({ updated: true });
  });

  // GET /api/admin/moderation
  router.get('/moderation', async (_req: AuthenticatedRequest, res: Response) => {
    const campaigns = await db.query(
      `SELECT c.*, a.company_name, b.daily_budget_micros, b.total_budget_micros, b.max_bid_micros,
              adv.format AS ad_format, crt.id AS creative_id, crt.title AS creative_title,
              crt.description AS creative_description, crt.media_url, crt.destination_url,
              crt.cta_text, crt.dimensions, crt.approval_status AS creative_approval
       FROM campaigns c
       JOIN advertiser_accounts a ON a.id = c.advertiser_id
       JOIN campaign_budgets b ON b.campaign_id = c.id
       LEFT JOIN advertisements adv ON adv.campaign_id = c.id
       LEFT JOIN ad_creatives crt ON crt.advertisement_id = adv.id
       ORDER BY CASE WHEN c.moderation_status = 'pending' THEN 0 ELSE 1 END, c.created_at DESC`
    );

    const reviews = await db.query('SELECT * FROM moderation_reviews ORDER BY created_at DESC LIMIT 30');

    const appeals = await db.query(
      `SELECT ap.*, c.name AS campaign_name, c.status AS campaign_status, a.company_name
       FROM campaign_appeals ap
       JOIN campaigns c ON c.id = ap.campaign_id
       JOIN advertiser_accounts a ON a.id = ap.advertiser_id
       ORDER BY CASE WHEN ap.status = 'open' THEN 0 ELSE 1 END, ap.created_at DESC`
    );

    const rawCategories = await db.query<Record<string, unknown>>(
      'SELECT * FROM prohibited_categories ORDER BY created_at DESC'
    );
    const prohibitedCategories = rawCategories.map((row) => ({
      ...row,
      keywords: (() => {
        try {
          return JSON.parse(String(row.keywords_json || '[]'));
        } catch {
          return [];
        }
      })(),
      active: Boolean(row.active),
    }));

    res.json({ campaigns, reviews, appeals, prohibitedCategories });
  });

  // POST /api/admin/appeals/:id/decision
  router.post('/appeals/:id/decision', async (req: AuthenticatedRequest, res: Response) => {
    const appealId = String(req.params.id);
    const { decision, adminResponse = '' } = req.body ?? {};
    if (!['approved', 'rejected'].includes(decision)) {
      res.status(400).json({ error: 'Decision must be approved or rejected' });
      return;
    }

    const appeal = await db.queryOne<{
      id: string;
      campaign_id: string;
      status: string;
      campaign_name: string;
      user_id: string;
      email: string;
    }>(
      `SELECT ap.id, ap.campaign_id, ap.status, c.name AS campaign_name, a.user_id, u.email
       FROM campaign_appeals ap
       JOIN campaigns c ON c.id = ap.campaign_id
       JOIN advertiser_accounts a ON a.id = ap.advertiser_id
       JOIN users u ON u.id = a.user_id
       WHERE ap.id = ?`,
      [appealId]
    );

    if (!appeal) {
      res.status(404).json({ error: 'Campaign appeal not found' });
      return;
    }
    if (appeal.status !== 'open') {
      res.status(400).json({ error: `Appeal has already been ${appeal.status}` });
      return;
    }

    const nowIso = new Date().toISOString();
    await withTransaction(db, async (tx) => {
      await tx.execute(
        `UPDATE campaign_appeals
         SET status = ?, resolution_notes = ?, reviewer_id = ?, resolved_at = ?
         WHERE id = ?`,
        [decision, String(adminResponse || `Appeal ${decision}`), req.auth!.userId, nowIso, appeal.id]
      );

      if (decision === 'approved') {
        await tx.execute(
          `UPDATE campaigns SET moderation_status = 'approved', status = 'active', updated_at = ? WHERE id = ?`,
          [nowIso, appeal.campaign_id]
        );
        await tx.execute(
          `UPDATE ad_creatives SET approval_status = 'approved'
           WHERE advertisement_id IN (SELECT id FROM advertisements WHERE campaign_id = ?)`,
          [appeal.campaign_id]
        );
      }

      await tx.execute(
        `INSERT INTO moderation_reviews (id, target_type, target_id, reviewer_id, decision, reason)
         VALUES (?, 'campaign', ?, ?, ?, ?)`,
        [
          `mod_${crypto.randomUUID().slice(0, 10)}`,
          appeal.campaign_id,
          req.auth!.userId,
          decision === 'approved' ? 'approved' : 'rejected',
          String(adminResponse || `Appeal ${decision}`),
        ]
      );

      await tx.execute(
        `INSERT INTO notifications (id, user_id, title, message, category)
         VALUES (?, ?, ?, ?, 'moderation')`,
        [
          `ntf_${crypto.randomUUID().slice(0, 10)}`,
          appeal.user_id,
          `Appeal ${decision}`,
          `Your appeal for ${appeal.campaign_name} was ${decision}. ${String(adminResponse || '')}`.trim(),
        ]
      );
    });

    await queueTransactionalEmail(db, {
      to: appeal.email,
      subject: `Looma Advertising — Campaign Appeal ${decision === 'approved' ? 'Approved' : 'Declined'}`,
      bodyText: `Your policy appeal for "${appeal.campaign_name}" was ${decision}. Reviewer note: ${adminResponse || 'Policy review completed.'}`,
      category: 'moderation',
    });

    res.json({ updated: true, appealId: appeal.id, decision });
  });

  // POST /api/admin/prohibited-categories
  router.post('/prohibited-categories', async (req: AuthenticatedRequest, res: Response) => {
    const validation = validateProhibitedCategoryInput(req.body ?? {});
    if (!validation.valid || !validation.value) {
      res.status(400).json({ error: validation.firstError, fieldErrors: validation.errors });
      return;
    }
    const { name: cleanName, keywords: keywordList, severity } = validation.value;

    const duplicate = await db.queryOne('SELECT id FROM prohibited_categories WHERE LOWER(name) = LOWER(?)', [cleanName]);
    if (duplicate) {
      res.status(409).json({
        error: 'A prohibited category with this name already exists',
        fieldErrors: { name: 'A category with this name already exists.' },
      });
      return;
    }

    const id = `pol_${crypto.randomUUID().slice(0, 10)}`;
    await db.execute(
      `INSERT INTO prohibited_categories (id, name, keywords_json, severity, active)
       VALUES (?, ?, ?, ?, 1)`,
      [id, cleanName, JSON.stringify(keywordList), severity]
    );

    res.status(201).json({ id, name: cleanName, keywords: keywordList, severity, active: true });
  });

  // PATCH /api/admin/prohibited-categories/:id
  router.patch('/prohibited-categories/:id', async (req: AuthenticatedRequest, res: Response) => {
    const id = String(req.params.id);
    const existing = await db.queryOne<{
      id: string;
      name: string;
      keywords_json: string;
      severity: string;
      active: number;
    }>('SELECT id, name, keywords_json, severity, active FROM prohibited_categories WHERE id = ?', [id]);
    if (!existing) {
      res.status(404).json({ error: 'Policy rule not found' });
      return;
    }

    const { name, keywords, severity, active } = req.body ?? {};
    const nextName = name !== undefined ? String(name).trim() : existing.name;
    if (!nextName) {
      res.status(400).json({ error: 'Category name cannot be empty' });
      return;
    }
    if (nextName.toLowerCase() !== existing.name.toLowerCase()) {
      const dup = await db.queryOne(
        'SELECT id FROM prohibited_categories WHERE LOWER(name) = LOWER(?) AND id != ?',
        [nextName, id]
      );
      if (dup) {
        res.status(409).json({ error: 'A prohibited category with this name already exists' });
        return;
      }
    }

    let nextKeywordsJson = existing.keywords_json;
    if (keywords !== undefined) {
      const keywordList = Array.isArray(keywords)
        ? keywords.map((k) => String(k).trim()).filter(Boolean)
        : String(keywords || '')
            .split(',')
            .map((k) => k.trim())
            .filter(Boolean);
      if (keywordList.length === 0) {
        res.status(400).json({ error: 'At least one keyword is required' });
        return;
      }
      nextKeywordsJson = JSON.stringify(keywordList);
    }

    const nextSeverity = severity !== undefined ? String(severity) : existing.severity;
    if (!['block', 'review'].includes(nextSeverity)) {
      res.status(400).json({ error: 'Severity must be block or review' });
      return;
    }
    const nextActive = active !== undefined ? (active ? 1 : 0) : existing.active;

    await db.execute(
      'UPDATE prohibited_categories SET name = ?, keywords_json = ?, severity = ?, active = ? WHERE id = ?',
      [nextName, nextKeywordsJson, nextSeverity, nextActive, id]
    );

    res.json({
      updated: true,
      id,
      name: nextName,
      keywords: JSON.parse(nextKeywordsJson),
      severity: nextSeverity,
      active: Boolean(nextActive),
    });
  });

  // DELETE /api/admin/prohibited-categories/:id
  router.delete('/prohibited-categories/:id', async (req: AuthenticatedRequest, res: Response) => {
    const del = await db.execute('DELETE FROM prohibited_categories WHERE id = ?', [String(req.params.id)]);
    if (del.rowCount === 0) {
      res.status(404).json({ error: 'Policy rule not found' });
      return;
    }
    res.json({ deleted: true });
  });

  // POST /api/admin/moderation/decision
  router.post('/moderation/decision', async (req: AuthenticatedRequest, res: Response) => {
    const { campaignId, decision, reason = 'Policy compliance review completed' } = req.body ?? {};
    if (!campaignId || !['approved', 'rejected', 'suspended'].includes(decision)) {
      res.status(400).json({ error: 'campaignId and valid decision (approved, rejected, suspended) are required' });
      return;
    }

    const camp = await db.queryOne<{ id: string; name: string; user_id: string }>(
      `SELECT c.id, c.name, a.user_id
       FROM campaigns c
       JOIN advertiser_accounts a ON a.id = c.advertiser_id
       WHERE c.id = ?`,
      [campaignId]
    );

    if (!camp) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }

    const nowIso = new Date().toISOString();
    await withTransaction(db, async (tx) => {
      const nextCampaignStatus = decision === 'approved' ? 'active' : decision === 'suspended' ? 'suspended' : 'rejected';
      await tx.execute('UPDATE campaigns SET moderation_status = ?, status = ?, updated_at = ? WHERE id = ?', [
        decision,
        nextCampaignStatus,
        nowIso,
        camp.id,
      ]);

      await tx.execute(
        `UPDATE ad_creatives SET approval_status = ?
         WHERE advertisement_id IN (SELECT id FROM advertisements WHERE campaign_id = ?)`,
        [decision === 'approved' ? 'approved' : 'rejected', camp.id]
      );

      await tx.execute(
        `INSERT INTO moderation_reviews (id, target_type, target_id, reviewer_id, decision, reason)
         VALUES (?, 'campaign', ?, ?, ?, ?)`,
        [`mod_${crypto.randomUUID().slice(0, 10)}`, camp.id, req.auth!.userId, decision, String(reason)]
      );

      await tx.execute(
        `INSERT INTO notifications (id, user_id, title, message, category)
         VALUES (?, ?, ?, ?, 'moderation')`,
        [
          `ntf_${crypto.randomUUID().slice(0, 10)}`,
          camp.user_id,
          `Campaign ${decision}`,
          `${camp.name} was marked ${decision}: ${String(reason)}`,
        ]
      );
    });

    res.json({ updated: true, campaignId: camp.id, decision });
  });

  // GET /api/admin/fraud
  router.get('/fraud', async (_req: AuthenticatedRequest, res: Response) => {
    const alerts = await db.query(
      `SELECT f.*, p.organization_name AS publisher_name, c.name AS campaign_name
       FROM fraud_alerts f
       LEFT JOIN publisher_accounts p ON p.id = f.publisher_id
       LEFT JOIN campaigns c ON c.id = f.campaign_id
       ORDER BY CASE WHEN f.status = 'open' THEN 0 ELSE 1 END, f.created_at DESC`
    );

    const invalidClicks = await db.query(
      `SELECT k.id, k.campaign_id, k.publisher_id, k.invalid_reason, k.created_at, p.organization_name AS publisher_name
       FROM clicks k
       JOIN publisher_accounts p ON p.id = k.publisher_id
       WHERE k.is_valid = 0
       ORDER BY k.created_at DESC
       LIMIT 25`
    );

    res.json({ alerts, invalidClicks });
  });

  // POST /api/admin/fraud/:id/resolve
  router.post('/fraud/:id/resolve', async (req: AuthenticatedRequest, res: Response) => {
    const { status, resolutionNotes = '', deductMicros = 0 } = req.body ?? {};
    const fieldErrors: Record<string, string> = {};
    if (!['confirmed_ivt', 'dismissed', 'investigating'].includes(String(status))) {
      fieldErrors.status = 'Status must be confirmed_ivt, dismissed, or investigating.';
    }
    const notesErr = validateTextLength(resolutionNotes, {
      label: 'Resolution notes',
      required: false,
      min: 1,
      max: 1000,
      allowNewlines: true,
    });
    if (notesErr) fieldErrors.resolutionNotes = notesErr;
    const deductRes = validateNumberRange(deductMicros, {
      label: 'Clawback deduction (micros)',
      min: 0,
      max: 1_000_000_000_000,
      integer: true,
    });
    if (deductRes.error) fieldErrors.deductMicros = deductRes.error;
    const firstKey = Object.keys(fieldErrors)[0];
    if (firstKey) {
      res.status(400).json({ error: fieldErrors[firstKey], fieldErrors });
      return;
    }

    const alert = await db.queryOne<{ id: string; publisher_id: string | null }>(
      'SELECT * FROM fraud_alerts WHERE id = ?',
      [String(req.params.id)]
    );
    if (!alert) {
      res.status(404).json({ error: 'Fraud alert not found' });
      return;
    }

    const nowIso = new Date().toISOString();
    const resolveResult = await withTransaction(db, async (tx) => {
      const claimAlert = await tx.execute(
        `UPDATE fraud_alerts
         SET status = ?, reviewed_by = ?, resolution_notes = ?, resolved_at = ?
         WHERE id = ? AND status NOT IN ('confirmed_ivt', 'dismissed')`,
        [status, req.auth!.userId, String(resolutionNotes), nowIso, alert.id]
      );
      if (claimAlert.rowCount === 0) {
        return { alreadyResolved: true };
      }

      if (status === 'confirmed_ivt' && alert.publisher_id) {
        await tx.execute(
          `UPDATE publisher_accounts
           SET traffic_quality_score = CASE WHEN traffic_quality_score - 5 > 10 THEN traffic_quality_score - 5 ELSE 10 END
           WHERE id = ?`,
          [alert.publisher_id]
        );

        const clawback = Math.max(0, Math.round(Number(deductMicros) || 0));
        if (clawback > 0) {
          const wallet = await tx.queryOne<{ id: string; available_micros: number }>(
            'SELECT id, available_micros FROM publisher_wallets WHERE publisher_id = ?',
            [alert.publisher_id]
          );
          if (wallet) {
            const avail = Number(wallet.available_micros);
            const actualDeduct = Math.min(avail, clawback);
            if (actualDeduct > 0) {
              const deductRes = await tx.execute(
                `UPDATE publisher_wallets
                 SET available_micros = CASE WHEN available_micros >= ? THEN available_micros - ? ELSE 0 END,
                     invalid_deducted_micros = invalid_deducted_micros + ?,
                     updated_at = ?
                 WHERE id = ?`,
                [actualDeduct, actualDeduct, actualDeduct, nowIso, wallet.id]
              );
              if (deductRes.rowCount > 0) {
                const updatedWal = (await tx.queryOne<{ available_micros: number }>(
                  'SELECT available_micros FROM publisher_wallets WHERE id = ?',
                  [wallet.id]
                ))!;
                const newBal = Number(updatedWal.available_micros);

                await tx.execute(
                  `INSERT INTO financial_ledger (id, idempotency_key, account_type, account_id, entry_type, direction, amount_micros, balance_after_micros, currency, reference_type, reference_id, description)
                   VALUES (?, ?, 'publisher_wallet', ?, 'ivt_deduction', 'debit', ?, ?, 'USD', 'fraud_alert', ?, ?)`,
                  [
                    `led_${crypto.randomUUID().slice(0, 12)}`,
                    `ivt_${alert.id}`,
                    wallet.id,
                    actualDeduct,
                    newBal,
                    alert.id,
                    'Invalid traffic revenue adjustment',
                  ]
                );
              }
            }
          }
        }
      }
      return { alreadyResolved: false };
    });

    if (resolveResult.alreadyResolved) {
      res.status(409).json({ error: 'Fraud alert has already been resolved' });
      return;
    }

    res.json({ updated: true });
  });

  // GET /api/admin/finance
  router.get('/finance', async (_req: AuthenticatedRequest, res: Response) => {
    const withdrawals = await db.query(
      `SELECT w.*, p.organization_name
       FROM withdrawals w
       JOIN publisher_accounts p ON p.id = w.publisher_id
       ORDER BY CASE WHEN w.status = 'pending' THEN 0 ELSE 1 END, w.created_at DESC`
    );

    const deposits = await db.query(
      `SELECT d.*, a.company_name
       FROM deposits d
       JOIN advertiser_accounts a ON a.id = d.advertiser_id
       ORDER BY d.created_at DESC LIMIT 30`
    );

    const ledger = await db.query('SELECT * FROM financial_ledger ORDER BY created_at DESC LIMIT 60');

    const reservations = await db.query(
      `SELECT r.*, a.company_name, c.name AS campaign_name
       FROM budget_reservations r
       JOIN advertiser_accounts a ON a.id = r.advertiser_id
       JOIN campaigns c ON c.id = r.campaign_id
       ORDER BY r.created_at DESC
       LIMIT 40`
    );

    res.json({ withdrawals, deposits, ledger, reservations });
  });

  // GET /api/admin/monitoring
  router.get('/monitoring', async (_req: AuthenticatedRequest, res: Response) => {
    res.json({
      monitoring: await getOperationalMonitoringSnapshot(db),
      featureFlags: await getFeatureFlags(db),
    });
  });

  // POST /api/admin/withdrawals/:id/decision
  router.post('/withdrawals/:id/decision', async (req: AuthenticatedRequest, res: Response) => {
    const { decision, notes = '' } = req.body ?? {};
    if (!['paid', 'rejected'].includes(decision)) {
      res.status(400).json({ error: 'Decision must be paid or rejected' });
      return;
    }

    const wdr = await db.queryOne<{
      id: string;
      publisher_id: string;
      amount_micros: number;
      payout_method: string;
      payout_destination: string;
      status: string;
      publisher_email: string;
    }>(
      `SELECT w.*, u.email AS publisher_email
       FROM withdrawals w
       JOIN publisher_accounts p ON p.id = w.publisher_id
       JOIN users u ON u.id = p.user_id
       WHERE w.id = ?`,
      [String(req.params.id)]
    );
    if (!wdr || wdr.status !== 'pending') {
      res.status(400).json({ error: 'Pending withdrawal not found' });
      return;
    }

    const amountMicros = Number(wdr.amount_micros);
    const nowIso = new Date().toISOString();

    if (decision === 'rejected') {
      const rejectedOk = await withTransaction(db, async (tx) => {
        const claim = await tx.execute(
          `UPDATE withdrawals
           SET status = 'rejected', reviewed_by = ?, notes = ?, processed_at = ?
           WHERE id = ? AND status = 'pending'`,
          [req.auth!.userId, String(notes || 'Marked rejected'), nowIso, wdr.id]
        );
        if (claim.rowCount === 0) return false;

        await tx.execute(
          `UPDATE publisher_wallets
           SET pending_micros = CASE WHEN pending_micros >= ? THEN pending_micros - ? ELSE 0 END,
               available_micros = available_micros + ?,
               updated_at = ?
           WHERE publisher_id = ?`,
          [amountMicros, amountMicros, amountMicros, nowIso, wdr.publisher_id]
        );
        return true;
      });

      if (!rejectedOk) {
        res.status(409).json({ error: 'Withdrawal was already processed' });
        return;
      }

      const finalNotes = String(notes || 'Marked rejected');
      await queueTransactionalEmail(db, {
        to: wdr.publisher_email,
        subject: 'Looma Advertising — Publisher Payout Returned',
        bodyText: `Your withdrawal of $${(amountMicros / 1_000_000).toFixed(2)} was marked rejected. Reference: ${finalNotes}`,
        category: 'billing',
      });

      res.json({
        updated: true,
        decision,
        payoutMode: null,
        transferRef: null,
      });
      return;
    }

    // Atomically lock withdrawal as 'approved' before dispatching external payout to prevent double-pay races
    const claimForPayout = await db.execute(
      `UPDATE withdrawals
       SET status = 'approved', reviewed_by = ?, processed_at = ?
       WHERE id = ? AND status = 'pending'`,
      [req.auth!.userId, nowIso, wdr.id]
    );
    if (claimForPayout.rowCount === 0) {
      res.status(409).json({ error: 'Withdrawal is already being processed or settled' });
      return;
    }

    let transferInfo: { mode: 'live' | 'sandbox'; transferRef: string } | null = null;
    try {
      transferInfo = await dispatchProviderPayout({
        payoutMethod: wdr.payout_method,
        destination: wdr.payout_destination,
        amountUsd: amountMicros / 1_000_000,
        withdrawalId: wdr.id,
      });
    } catch (err) {
      await db.execute(
        `UPDATE withdrawals SET status = 'pending', processed_at = NULL WHERE id = ? AND status = 'approved'`,
        [wdr.id]
      );
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Payout provider dispatch failed',
      });
      return;
    }

    const finalNotes = `${notes || 'Payout settled'} [${transferInfo.mode.toUpperCase()} Ref: ${transferInfo.transferRef}]`.trim();
    const settledIso = new Date().toISOString();

    await withTransaction(db, async (tx) => {
      const finalizeRes = await tx.execute(
        `UPDATE withdrawals SET status = 'paid', reviewed_by = ?, notes = ?, processed_at = ? WHERE id = ? AND status = 'approved'`,
        [req.auth!.userId, finalNotes, settledIso, wdr.id]
      );
      if (finalizeRes.rowCount === 0) return;

      const wallet = (await tx.queryOne<{ id: string }>(
        'SELECT id FROM publisher_wallets WHERE publisher_id = ?',
        [wdr.publisher_id]
      ))!;

      await tx.execute(
        `UPDATE publisher_wallets
         SET pending_micros = CASE WHEN pending_micros >= ? THEN pending_micros - ? ELSE 0 END,
             updated_at = ?
         WHERE id = ?`,
        [amountMicros, amountMicros, settledIso, wallet.id]
      );

      const updatedWallet = (await tx.queryOne<{ available_micros: number }>(
        'SELECT available_micros FROM publisher_wallets WHERE id = ?',
        [wallet.id]
      ))!;
      const availMicros = Number(updatedWallet.available_micros);

      await tx.execute(
        `INSERT INTO financial_ledger (id, idempotency_key, account_type, account_id, entry_type, direction, amount_micros, balance_after_micros, currency, reference_type, reference_id, description)
         VALUES (?, ?, 'publisher_wallet', ?, 'withdrawal', 'debit', ?, ?, 'USD', 'withdrawal', ?, ?)`,
        [
          `led_${crypto.randomUUID().slice(0, 12)}`,
          `wdr_paid_${wdr.id}`,
          wallet.id,
          amountMicros,
          availMicros,
          wdr.id,
          `Publisher payout settled (${finalNotes})`,
        ]
      );
    });

    await queueTransactionalEmail(db, {
      to: wdr.publisher_email,
      subject: 'Looma Advertising — Publisher Payout Disbursed',
      bodyText: `Your withdrawal of $${(amountMicros / 1_000_000).toFixed(2)} was marked paid. Reference: ${finalNotes}`,
      category: 'billing',
    });

    res.json({
      updated: true,
      decision,
      payoutMode: transferInfo?.mode ?? null,
      transferRef: transferInfo?.transferRef ?? null,
    });
  });

  // GET /api/admin/settings
  router.get('/settings', async (_req: AuthenticatedRequest, res: Response) => {
    const rows = await db.query<{ key: string; value_json: string; updated_at: string }>(
      'SELECT key, value_json, updated_at FROM platform_settings'
    );
    const settings: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        settings[r.key] = JSON.parse(r.value_json);
      } catch {
        settings[r.key] = r.value_json;
      }
    }
    res.json({ settings, featureFlags: await getFeatureFlags(db) });
  });

  // PUT /api/admin/settings
  router.put('/settings', async (req: AuthenticatedRequest, res: Response) => {
    const updates = req.body?.settings;
    if (!isPlainObject(updates)) {
      res.status(400).json({ error: 'settings object is required', fieldErrors: { settings: 'Provide a settings object.' } });
      return;
    }
    const settingsValidation = validatePlatformSettingsInput(updates);
    if (!settingsValidation.valid || !settingsValidation.value) {
      res.status(400).json({ error: settingsValidation.firstError, fieldErrors: settingsValidation.errors });
      return;
    }
    const validatedUpdates = settingsValidation.value;
    const nowIso = new Date().toISOString();

    await withTransaction(db, async (tx) => {
      for (const [k, v] of Object.entries(validatedUpdates)) {
        await tx.execute(
          `INSERT INTO platform_settings (key, value_json, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = ?`,
          [k, JSON.stringify(v), nowIso, nowIso]
        );
      }

      await tx.execute(
        `INSERT INTO audit_logs (id, actor_user_id, action, resource_type, resource_id, details_json)
         VALUES (?, ?, 'update_platform_settings', 'platform_settings', 'global', ?)`,
        [`aud_${crypto.randomUUID().slice(0, 10)}`, req.auth!.userId, JSON.stringify(validatedUpdates)]
      );
    });

    res.json({ updated: true, featureFlags: await getFeatureFlags(db) });
  });

  // GET /api/admin/jobs
  router.get('/jobs', async (_req: AuthenticatedRequest, res: Response) => {
    const runs = await db.query(
      'SELECT *, created_at AS ran_at FROM scheduled_job_runs ORDER BY created_at DESC LIMIT 25'
    );
    res.json({ runs });
  });

  // POST /api/admin/jobs/run
  router.post('/jobs/run', async (req: AuthenticatedRequest, res: Response) => {
    const jobName = String(req.body?.jobName || '') as ScheduledJobName;
    if (
      ![
        'daily_budget_reset',
        'publisher_earnings_settlement',
        'expired_token_cleanup',
        'release_expired_reservations',
      ].includes(jobName)
    ) {
      res.status(400).json({ error: 'Invalid jobName' });
      return;
    }
    const result = await runScheduledJob(db, jobName, req.auth!.userId);
    res.json(result);
  });

  return router;
}
