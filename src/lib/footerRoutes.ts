export type FooterPageSlug =
  | 'auction-engine'
  | 'ad-formats'
  | 'pricing-models'
  | 'faq'
  | 'web-sdk'
  | 'rest-api'
  | 'integration-contract'
  | 'contact'
  | 'gdpr-data-requests'
  | 'privacy-policy'
  | 'advertiser-terms'
  | 'ad-quality-policy';

export type FooterPageCategory = 'Platform' | 'Developers' | 'Governance';

export interface FooterPageMeta {
  slug: FooterPageSlug;
  path: string;
  category: FooterPageCategory;
  navLabel: string;
  title: string;
  subtitle: string;
  effectiveLabel: string;
}

export const FOOTER_PAGES: FooterPageMeta[] = [
  {
    slug: 'auction-engine',
    path: '/auction-engine',
    category: 'Platform',
    navLabel: 'Auction Engine',
    title: 'Deterministic First-Price Auction Engine',
    subtitle:
      'How Looma Advertising evaluates campaign eligibility, rotates ads across multi-slot feeds, and protects prepaid balances.',
    effectiveLabel: 'Architecture Standard · Launch Release',
  },
  {
    slug: 'ad-formats',
    path: '/ad-formats',
    category: 'Platform',
    navLabel: 'Ad Formats',
    title: 'Supported Advertising Formats & Creative Specs',
    subtitle:
      'Editorial native cards, responsive display units, sponsored feed slots, and video creatives with mandatory sponsorship disclosure.',
    effectiveLabel: 'Creative Specification · IAB & Looma Native',
  },
  {
    slug: 'pricing-models',
    path: '/pricing-models',
    category: 'Platform',
    navLabel: 'Pricing Models',
    title: 'Pricing Models & Prepaid Wallet Accounting',
    subtitle:
      'Configurable CPM, CPC, CPA, CPI, CPV, and Fixed Sponsorship billing backed by integer minor-unit ledger accounting.',
    effectiveLabel: 'Prepaid Only · 1 USD = 1,000,000 Micros',
  },
  {
    slug: 'faq',
    path: '/faq',
    category: 'Platform',
    navLabel: 'FAQ',
    title: 'Frequently Asked Questions',
    subtitle:
      'Answers covering prepaid overspend protection, invalid-traffic filtering, Looma integration resilience, and billing rails.',
    effectiveLabel: 'Platform Reference · Updated 2026',
  },
  {
    slug: 'web-sdk',
    path: '/web-sdk',
    category: 'Developers',
    navLabel: 'Web SDK Guide',
    title: 'Web SDK Integration Guide',
    subtitle:
      'Embed Looma ad placements with viewability-gated impression tracking, explicit privacy consent flags, and fail-open rendering.',
    effectiveLabel: 'Client SDK · First-Party Mode Active',
  },
  {
    slug: 'rest-api',
    path: '/rest-api',
    category: 'Developers',
    navLabel: 'REST Delivery API',
    title: 'REST Ad Delivery & Event Verification API',
    subtitle:
      'Server-to-server and client delivery endpoints for ad selection, HMAC-signed impression confirmation, clicks, and conversions.',
    effectiveLabel: 'REST API v1 · JSON over HTTPS',
  },
  {
    slug: 'integration-contract',
    path: '/integration-contract',
    category: 'Developers',
    navLabel: 'Integration Contract',
    title: 'Looma First-Party Integration Contract',
    subtitle:
      'Live publisher adapter specification defining feed rendering ownership, SSO membership verification, timeouts, and billing boundaries.',
    effectiveLabel: 'Live Contract Spec · Verified via API',
  },
  {
    slug: 'contact',
    path: '/contact',
    category: 'Developers',
    navLabel: 'Contact Engineering',
    title: 'Contact Engineering & Commercial Desk',
    subtitle:
      'Reach our advertiser partnerships, Looma feed engineering, billing reconciliation, and privacy compliance teams directly.',
    effectiveLabel: 'Response SLA · Within 1 Business Day',
  },
  {
    slug: 'gdpr-data-requests',
    path: '/gdpr-data-requests',
    category: 'Governance',
    navLabel: 'GDPR & Data Requests',
    title: 'GDPR & Data Rights Request Portal',
    subtitle:
      'Submit verifiable requests for personal data export, deletion, rectification, or consent withdrawal across GDPR, UK GDPR, and US state laws.',
    effectiveLabel: 'Compliance Workflow · Logged & Auditable',
  },
  {
    slug: 'privacy-policy',
    path: '/privacy-policy',
    category: 'Governance',
    navLabel: 'Privacy Policy',
    title: 'Privacy Policy & Data Minimization',
    subtitle:
      'How Looma Advertising enforces consent-first targeting, avoids invasive browser fingerprinting, and hashes operational traffic signals.',
    effectiveLabel: 'Effective January 2026 · Privacy Standard',
  },
  {
    slug: 'advertiser-terms',
    path: '/advertiser-terms',
    category: 'Governance',
    navLabel: 'Advertiser Terms',
    title: 'Prepaid Advertiser Terms of Service',
    subtitle:
      'Commercial terms governing prepaid advertiser wallets, atomic budget reservations, verified billable events, and unused balance refunds.',
    effectiveLabel: 'Effective January 2026 · Prepaid Launch Terms',
  },
  {
    slug: 'ad-quality-policy',
    path: '/ad-quality-policy',
    category: 'Governance',
    navLabel: 'Ad Quality Policy',
    title: 'Advertising Quality & Content Policy',
    subtitle:
      'Mandatory pre-delivery creative moderation, prohibited content categories, landing-page safety checks, and invalid-traffic enforcement.',
    effectiveLabel: 'Enforcement Policy · Pre-Delivery Moderation',
  },
];

const SLUG_TO_META = new Map<FooterPageSlug, FooterPageMeta>(
  FOOTER_PAGES.map((page) => [page.slug, page])
);

const PATH_TO_SLUG = new Map<string, FooterPageSlug>(
  FOOTER_PAGES.map((page) => [page.path, page.slug])
);

export function getFooterPageMeta(slug: FooterPageSlug): FooterPageMeta {
  const meta = SLUG_TO_META.get(slug);
  if (!meta) {
    throw new Error(`Unknown footer page slug: ${slug}`);
  }
  return meta;
}

export function getPathForFooterPage(slug: FooterPageSlug): string {
  return getFooterPageMeta(slug).path;
}

export function getFooterPageFromPath(pathname: string): FooterPageSlug | null {
  const normalized = pathname.trim().toLowerCase().replace(/\/+$/, '') || '/';
  if (normalized === '/') return null;
  return PATH_TO_SLUG.get(normalized) ?? null;
}

export function getFooterPagesByCategory(category: FooterPageCategory): FooterPageMeta[] {
  return FOOTER_PAGES.filter((page) => page.category === category);
}
