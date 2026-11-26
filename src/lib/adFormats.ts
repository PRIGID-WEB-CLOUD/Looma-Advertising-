export type AdFormat =
  | 'native'
  | 'banner'
  | 'image'
  | 'responsive'
  | 'text'
  | 'video'
  | 'sponsored';

export type MediaMode = 'image' | 'video' | 'none';

export interface DimensionOption {
  value: string;
  label: string;
}

export interface AdFormatSpec {
  format: AdFormat;
  label: string;
  summary: string;
  compatiblePlacements: string[];
  mediaMode: MediaMode;
  mediaRequired: boolean;
  acceptMime: string;
  uploadHint: string;
  dimensionsOptions: DimensionOption[];
  defaultDimensions: string;
  recommendedPricingModels: string[];
  defaultCta: string;
  titleLabel: string;
  titlePlaceholder: string;
  titleMaxLength: number;
  descriptionLabel: string;
  descriptionPlaceholder: string;
  descriptionMaxLength: number;
  disclosureLabel: string;
}

export const DEFAULT_IMAGE_ASSET =
  '/src/assets/images/creative_fintech_card_1795552815861.jpg';

export const AD_FORMATS: AdFormat[] = [
  'native',
  'banner',
  'image',
  'responsive',
  'text',
  'video',
  'sponsored',
];

export const AD_FORMAT_SPECS: Record<AdFormat, AdFormatSpec> = {
  native: {
    format: 'native',
    label: 'Native Ad',
    summary:
      'Blends directly into Looma social and content feeds with editorial typography, optional 16:10 hero image, and inline CTA.',
    compatiblePlacements: ['native', 'in_feed', 'responsive'],
    mediaMode: 'image',
    mediaRequired: false,
    acceptMime: 'image/jpeg,image/png,image/webp',
    uploadHint: 'Recommended 1200×628 or 16:10 JPEG, PNG, or WEBP up to 10 MB',
    dimensionsOptions: [
      { value: 'responsive', label: 'Fluid Feed Card (Responsive)' },
      { value: '1200x628', label: '1200×628 Landscape Card' },
    ],
    defaultDimensions: 'responsive',
    recommendedPricingModels: ['CPC', 'CPM'],
    defaultCta: 'Explore Offer',
    titleLabel: 'Feed Headline',
    titlePlaceholder: 'Automate Multi-Currency Treasury Operations',
    titleMaxLength: 75,
    descriptionLabel: 'Feed Summary Copy',
    descriptionPlaceholder:
      'Issue corporate cards with deterministic spend caps and real-time ledger reconciliation.',
    descriptionMaxLength: 160,
    disclosureLabel: 'Sponsored · Looma Feed',
  },
  banner: {
    format: 'banner',
    label: 'Banner Ad',
    summary:
      'Fixed-size IAB display banner engineered for high-visibility header, sidebar, and mobile slots.',
    compatiblePlacements: ['banner', 'interstitial', 'responsive'],
    mediaMode: 'image',
    mediaRequired: true,
    acceptMime: 'image/jpeg,image/png,image/webp',
    uploadHint: 'Match your selected IAB banner dimensions (JPEG, PNG, or WEBP up to 10 MB)',
    dimensionsOptions: [
      { value: '728x90', label: '728×90 Leaderboard' },
      { value: '300x250', label: '300×250 Medium Rectangle' },
      { value: '320x50', label: '320×50 Mobile Banner' },
      { value: '160x600', label: '160×600 Wide Skyscraper' },
    ],
    defaultDimensions: '728x90',
    recommendedPricingModels: ['CPM', 'CPC', 'FIXED'],
    defaultCta: 'Shop Now',
    titleLabel: 'Banner Headline (Concise)',
    titlePlaceholder: 'Zero-Fee Corporate Cards for Scaling Teams',
    titleMaxLength: 50,
    descriptionLabel: 'Short Banner Tagline',
    descriptionPlaceholder: 'Instant virtual issuance and live spend alerts.',
    descriptionMaxLength: 90,
    disclosureLabel: 'Ad',
  },
  image: {
    format: 'image',
    label: 'Image Ad',
    summary:
      'Visual-first creative showcasing a full-bleed product or brand photograph with a compact caption bar.',
    compatiblePlacements: ['banner', 'native', 'in_feed', 'interstitial', 'responsive'],
    mediaMode: 'image',
    mediaRequired: true,
    acceptMime: 'image/jpeg,image/png,image/webp',
    uploadHint: 'High-resolution 1200×628 or 1080×1080 JPEG, PNG, or WEBP up to 10 MB',
    dimensionsOptions: [
      { value: '1200x628', label: '1200×628 Landscape (1.91:1)' },
      { value: '1080x1080', label: '1080×1080 Square (1:1)' },
      { value: '300x250', label: '300×250 Display Card' },
    ],
    defaultDimensions: '1200x628',
    recommendedPricingModels: ['CPM', 'CPC'],
    defaultCta: 'Learn More',
    titleLabel: 'Image Caption Headline',
    titlePlaceholder: 'Engineered Performance Running Collection',
    titleMaxLength: 60,
    descriptionLabel: 'Supporting Caption',
    descriptionPlaceholder: 'Lightweight carbon-plate cushioning built for everyday speed.',
    descriptionMaxLength: 110,
    disclosureLabel: 'Promoted',
  },
  responsive: {
    format: 'responsive',
    label: 'Responsive Ad',
    summary:
      'Automatically reflows across desktop leaderboards, mobile feeds, and sidebar slots for maximum inventory reach.',
    compatiblePlacements: ['banner', 'native', 'in_feed', 'video', 'interstitial', 'responsive'],
    mediaMode: 'image',
    mediaRequired: false,
    acceptMime: 'image/jpeg,image/png,image/webp',
    uploadHint: '16:10 or 1.91:1 image automatically cropped per placement (JPEG, PNG, WEBP)',
    dimensionsOptions: [
      { value: 'responsive', label: 'Adaptive Multi-Viewport (Auto)' },
    ],
    defaultDimensions: 'responsive',
    recommendedPricingModels: ['CPC', 'CPM', 'CPA'],
    defaultCta: 'Get Started',
    titleLabel: 'Adaptive Headline',
    titlePlaceholder: 'Deploy Global Edge Infrastructure in Minutes',
    titleMaxLength: 70,
    descriptionLabel: 'Adaptive Description',
    descriptionPlaceholder:
      'Predictable pricing, deterministic routing, and real-time observability across 30+ regions.',
    descriptionMaxLength: 140,
    disclosureLabel: 'Ad · Adaptive',
  },
  text: {
    format: 'text',
    label: 'Text Ad',
    summary:
      'Lightweight, zero-media search and contextual text unit focused purely on high-intent headline, URL, and copy.',
    compatiblePlacements: ['native', 'responsive'],
    mediaMode: 'none',
    mediaRequired: false,
    acceptMime: '',
    uploadHint: 'Text ads do not use image or video files.',
    dimensionsOptions: [
      { value: 'text', label: 'Text-Only Unit (No Media)' },
    ],
    defaultDimensions: 'text',
    recommendedPricingModels: ['CPC', 'CPA'],
    defaultCta: 'Visit Site',
    titleLabel: 'Clickable Text Headline',
    titlePlaceholder: 'Automated Cloud FinOps — Cut Compute Spend 35%',
    titleMaxLength: 65,
    descriptionLabel: 'Text Ad Copy (2 Lines)',
    descriptionPlaceholder:
      'Audit idle clusters, right-size workloads, and enforce real-time spend budgets with zero agent overhead.',
    descriptionMaxLength: 150,
    disclosureLabel: 'Ad',
  },
  video: {
    format: 'video',
    label: 'Video Ad',
    summary:
      'In-stream and in-feed motion unit built for CPV/CPM storytelling with aspect-matched video playback and companion CTA.',
    compatiblePlacements: ['video', 'in_feed', 'interstitial', 'responsive'],
    mediaMode: 'video',
    mediaRequired: true,
    acceptMime: 'video/mp4,video/webm',
    uploadHint: 'Upload MP4 or WEBM video up to 10 MB, or provide a direct video stream URL',
    dimensionsOptions: [
      { value: '16:9', label: '16:9 Widescreen (1920×1080)' },
      { value: '9:16', label: '9:16 Vertical Feed (1080×1920)' },
      { value: '1:1', label: '1:1 Square Feed (1080×1080)' },
    ],
    defaultDimensions: '16:9',
    recommendedPricingModels: ['CPV', 'CPM'],
    defaultCta: 'Watch & Explore',
    titleLabel: 'Video Companion Headline',
    titlePlaceholder: 'See How Modern Treasury Teams Close Books 5× Faster',
    titleMaxLength: 65,
    descriptionLabel: 'Video Companion Summary',
    descriptionPlaceholder:
      '15-second walkthrough of automated reconciliation and instant multi-currency payouts.',
    descriptionMaxLength: 120,
    disclosureLabel: 'Sponsored Video',
  },
  sponsored: {
    format: 'sponsored',
    label: 'Sponsored Content',
    summary:
      'Long-form editorial brand story card with explicit sponsor disclosure, featured art, and deeper narrative copy.',
    compatiblePlacements: ['native', 'in_feed', 'responsive'],
    mediaMode: 'image',
    mediaRequired: false,
    acceptMime: 'image/jpeg,image/png,image/webp',
    uploadHint: 'Editorial cover image (1200×628 recommended, JPEG, PNG, or WEBP up to 10 MB)',
    dimensionsOptions: [
      { value: 'responsive', label: 'Editorial Native Card (Responsive)' },
      { value: '1200x628', label: '1200×628 Featured Article' },
    ],
    defaultDimensions: 'responsive',
    recommendedPricingModels: ['CPM', 'FIXED', 'CPC'],
    defaultCta: 'Read Full Story',
    titleLabel: 'Editorial Article Title',
    titlePlaceholder: 'Inside the Architecture of Real-Time Cross-Border Settlement',
    titleMaxLength: 90,
    descriptionLabel: 'Editorial Story Excerpt',
    descriptionPlaceholder:
      'How engineering leaders eliminate batch delays and build immutable financial ledgers at global scale.',
    descriptionMaxLength: 240,
    disclosureLabel: 'Sponsored Content · Brand Story',
  },
};

export function isAdFormat(value: string): value is AdFormat {
  return (AD_FORMATS as string[]).includes(value);
}

export function getAdFormatSpec(format: string): AdFormatSpec {
  if (isAdFormat(format)) {
    return AD_FORMAT_SPECS[format];
  }
  return AD_FORMAT_SPECS.native;
}

export function isVideoMediaUrl(url: string): boolean {
  const clean = url.trim().split('?')[0].split('#')[0];
  return /\.(mp4|webm|mov)$/i.test(clean);
}

export function updateTrackingParamMedium(trackingParams: string, format: AdFormat): string {
  const trimmed = trackingParams.trim();
  if (!trimmed) {
    return `utm_source=looma&utm_medium=${format}`;
  }
  if (/(^|&)utm_medium=[^&]*/i.test(trimmed)) {
    return trimmed.replace(/(^|&)utm_medium=[^&]*/i, `$1utm_medium=${format}`);
  }
  return `${trimmed}&utm_medium=${format}`;
}

export interface FormatFormSlice {
  format: string;
  dimensions: string;
  mediaUrl: string;
  pricingModel: string;
  ctaText: string;
  trackingParams: string;
}

const ALL_DEFAULT_CTAS = new Set(
  Object.values(AD_FORMAT_SPECS).map((spec) => spec.defaultCta)
);

export function applyFormatChange<T extends FormatFormSlice>(
  current: T,
  nextFormatRaw: string,
  opts?: { isEditing?: boolean }
): T {
  const spec = getAdFormatSpec(nextFormatRaw);
  const allowedDims = spec.dimensionsOptions.map((o) => o.value);
  const nextDimensions = allowedDims.includes(current.dimensions)
    ? current.dimensions
    : spec.defaultDimensions;

  let nextMediaUrl = current.mediaUrl;
  if (spec.mediaMode === 'none') {
    nextMediaUrl = '';
  } else if (spec.mediaMode === 'video') {
    if (!isVideoMediaUrl(current.mediaUrl)) {
      nextMediaUrl = '';
    }
  } else {
    // image-based format
    if (!current.mediaUrl || isVideoMediaUrl(current.mediaUrl)) {
      nextMediaUrl = DEFAULT_IMAGE_ASSET;
    }
  }

  let nextCta = current.ctaText;
  let nextPricingModel = current.pricingModel;

  if (!opts?.isEditing) {
    if (!current.ctaText.trim() || ALL_DEFAULT_CTAS.has(current.ctaText.trim())) {
      nextCta = spec.defaultCta;
    }
    if (spec.format === 'video' && current.pricingModel === 'CPC') {
      nextPricingModel = 'CPV';
    } else if (spec.format !== 'video' && current.pricingModel === 'CPV') {
      nextPricingModel = spec.recommendedPricingModels[0] || 'CPC';
    }
  }

  return {
    ...current,
    format: spec.format,
    dimensions: nextDimensions,
    mediaUrl: nextMediaUrl,
    ctaText: nextCta,
    pricingModel: nextPricingModel,
    trackingParams: updateTrackingParamMedium(current.trackingParams, spec.format),
  };
}

export function validateCreativeForFormat(input: {
  format: string;
  title: string;
  description: string;
  mediaUrl: string;
}): string | null {
  const spec = getAdFormatSpec(input.format);
  if (!input.title.trim()) {
    return `${spec.titleLabel} is required.`;
  }
  if (!input.description.trim()) {
    return `${spec.descriptionLabel} is required.`;
  }
  if (spec.mediaMode === 'image' && spec.mediaRequired && !input.mediaUrl.trim()) {
    return `${spec.label} requires an image asset. Select one from the media library or upload a JPEG, PNG, or WEBP file.`;
  }
  if (spec.mediaMode === 'image' && input.mediaUrl.trim() && isVideoMediaUrl(input.mediaUrl)) {
    return `${spec.label} requires an image asset rather than a video file.`;
  }
  return null;
}
