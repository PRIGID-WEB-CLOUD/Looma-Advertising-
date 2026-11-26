import React from 'react';
import { Play, Volume2, ExternalLink, Monitor, Smartphone, BookOpen } from 'lucide-react';
import { getAdFormatSpec, isVideoMediaUrl } from '../lib/adFormats';

export interface LiveAdPreviewProps {
  format: string;
  dimensions: string;
  pricingModel: string;
  title: string;
  description: string;
  mediaUrl: string;
  destinationUrl: string;
  ctaText: string;
}

function formatHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url || 'yourbrand.com';
  }
}

export const LiveAdPreview: React.FC<LiveAdPreviewProps> = ({
  format,
  dimensions,
  pricingModel,
  title,
  description,
  mediaUrl,
  destinationUrl,
  ctaText,
}) => {
  const spec = getAdFormatSpec(format);
  const headline = title.trim() || spec.titlePlaceholder;
  const copy = description.trim() || spec.descriptionPlaceholder;
  const cta = ctaText.trim() || spec.defaultCta;
  const host = formatHost(destinationUrl);
  const hasImage = Boolean(mediaUrl) && !isVideoMediaUrl(mediaUrl);
  const hasVideo = Boolean(mediaUrl) && isVideoMediaUrl(mediaUrl);

  return (
    <div className="space-y-4" data-testid="live-ad-preview" data-format={spec.format} data-dimensions={dimensions}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
        <span className="font-semibold text-slate-900 dark:text-white">
          Live {spec.label} Preview
        </span>
        <span className="font-mono text-[11px] px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
          {dimensions || spec.defaultDimensions} · {pricingModel}
        </span>
      </div>

      {/* TEXT AD PREVIEW — Pure text, zero media */}
      {spec.format === 'text' && (
        <div className="border border-slate-200 dark:border-slate-800 rounded-lg p-4 bg-white dark:bg-slate-950 space-y-1.5">
          <div className="flex items-center gap-2 text-[11px]">
            <span className="px-1.5 py-0.5 rounded border border-slate-300 dark:border-slate-700 font-semibold text-slate-700 dark:text-slate-200 leading-none">
              {spec.disclosureLabel}
            </span>
            <span className="font-mono text-slate-500 dark:text-slate-400 truncate">
              {destinationUrl || `https://${host}`}
            </span>
          </div>
          <div className="text-base font-semibold text-blue-700 dark:text-blue-400 hover:underline leading-snug break-words">
            {headline}
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed break-words">
            {copy}
          </p>
          <div className="pt-1 flex items-center gap-3 text-xs font-medium text-blue-700 dark:text-blue-400">
            <span className="inline-flex items-center gap-1">
              {cta}
              <ExternalLink className="w-3 h-3" />
            </span>
            <span className="text-[11px] text-slate-400 font-normal">· Text-only contextual unit</span>
          </div>
        </div>
      )}

      {/* BANNER AD PREVIEW — Adapts to IAB dimensions */}
      {spec.format === 'banner' && (
        <div className="border border-slate-200 dark:border-slate-800 rounded-lg p-3 bg-slate-100/70 dark:bg-slate-950/70">
          <div className="text-[10px] font-mono uppercase tracking-wider text-slate-500 mb-2">
            IAB Slot Frame · {dimensions || '728x90'}
          </div>

          {dimensions === '320x50' ? (
            <div className="max-w-[320px] mx-auto h-[58px] rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden flex items-center gap-2.5 pr-2">
              {hasImage && (
                <img
                  src={mediaUrl}
                  alt={headline}
                  referrerPolicy="no-referrer"
                  className="w-14 h-full object-cover shrink-0"
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="text-[10px] text-slate-400 uppercase font-semibold leading-none">{spec.disclosureLabel} · {host}</div>
                <div className="text-xs font-semibold text-slate-900 dark:text-white truncate mt-0.5">{headline}</div>
              </div>
              <span className="px-2 py-1 text-[11px] font-semibold text-white bg-blue-700 rounded whitespace-nowrap shrink-0">
                {cta}
              </span>
            </div>
          ) : dimensions === '160x600' ? (
            <div className="w-[180px] mx-auto rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden flex flex-col">
              {hasImage && (
                <div className="h-36 bg-slate-200 dark:bg-slate-800 relative">
                  <img
                    src={mediaUrl}
                    alt={headline}
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover"
                  />
                  <span className="absolute top-1.5 right-1.5 px-1.5 py-0.5 text-[10px] font-semibold bg-slate-900/80 text-white rounded">
                    {spec.disclosureLabel}
                  </span>
                </div>
              )}
              <div className="p-3 flex-1 flex flex-col justify-between space-y-3">
                <div>
                  <div className="text-[10px] font-mono text-slate-400 truncate">{host}</div>
                  <div className="mt-1 text-sm font-semibold text-slate-900 dark:text-white leading-snug break-words">
                    {headline}
                  </div>
                  <p className="mt-1.5 text-[11px] text-slate-600 dark:text-slate-300 leading-relaxed break-words">
                    {copy}
                  </p>
                </div>
                <span className="w-full text-center px-2.5 py-1.5 text-xs font-semibold text-white bg-blue-700 rounded">
                  {cta}
                </span>
              </div>
            </div>
          ) : dimensions === '300x250' ? (
            <div className="max-w-[300px] mx-auto rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
              {hasImage && (
                <div className="aspect-[16/9] bg-slate-200 dark:bg-slate-800 relative">
                  <img
                    src={mediaUrl}
                    alt={headline}
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover"
                  />
                  <span className="absolute top-2 right-2 px-1.5 py-0.5 text-[10px] font-semibold bg-slate-900/80 text-white rounded">
                    {spec.disclosureLabel}
                  </span>
                </div>
              )}
              <div className="p-3 space-y-2">
                <div className="text-sm font-semibold text-slate-900 dark:text-white leading-snug break-words">
                  {headline}
                </div>
                <p className="text-[11px] text-slate-600 dark:text-slate-300 line-clamp-2 break-words">
                  {copy}
                </p>
                <div className="flex items-center justify-between gap-2 pt-1">
                  <span className="text-[10px] font-mono text-slate-400 truncate">{host}</span>
                  <span className="px-2.5 py-1 text-xs font-semibold text-white bg-blue-700 rounded whitespace-nowrap">
                    {cta}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            /* 728x90 Leaderboard default */
            <div className="rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden flex items-center gap-3 pr-3 min-h-[84px]">
              {hasImage && (
                <div className="w-28 h-[84px] bg-slate-200 dark:bg-slate-800 shrink-0 relative">
                  <img
                    src={mediaUrl}
                    alt={headline}
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover"
                  />
                  <span className="absolute top-1 left-1 px-1 py-0.5 text-[9px] font-semibold bg-slate-900/80 text-white rounded">
                    {spec.disclosureLabel}
                  </span>
                </div>
              )}
              <div className="min-w-0 flex-1 py-2">
                <div className="text-sm font-semibold text-slate-900 dark:text-white truncate">
                  {headline}
                </div>
                <p className="text-[11px] text-slate-600 dark:text-slate-300 line-clamp-2 mt-0.5">
                  {copy}
                </p>
              </div>
              <span className="px-3 py-1.5 text-xs font-semibold text-white bg-blue-700 rounded whitespace-nowrap shrink-0">
                {cta}
              </span>
            </div>
          )}
        </div>
      )}

      {/* IMAGE AD PREVIEW — Full-bleed aspect-matched visual card */}
      {spec.format === 'image' && (
        <div
          className={`relative rounded-lg overflow-hidden border border-slate-200 dark:border-slate-800 bg-slate-900 ${
            dimensions === '1080x1080'
              ? 'aspect-square max-w-[320px] mx-auto'
              : dimensions === '300x250'
              ? 'aspect-[6/5] max-w-[300px] mx-auto'
              : 'aspect-[1200/628]'
          }`}
        >
          {hasImage ? (
            <img
              src={mediaUrl}
              alt={headline}
              referrerPolicy="no-referrer"
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-xs text-slate-400">
              Select or upload an image creative
            </div>
          )}
          <span className="absolute top-2.5 left-2.5 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-slate-950/75 text-white rounded">
            {spec.disclosureLabel}
          </span>
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-slate-950/90 via-slate-950/60 to-transparent p-3.5 text-white">
            <div className="text-sm font-semibold leading-snug break-words">{headline}</div>
            <div className="mt-1.5 flex items-center justify-between gap-2">
              <span className="text-[11px] text-slate-200 truncate">{copy}</span>
              <span className="px-2.5 py-1 text-xs font-semibold bg-white text-slate-950 rounded whitespace-nowrap shrink-0">
                {cta}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* VIDEO AD PREVIEW — Aspect-matched video player + companion CTA */}
      {spec.format === 'video' && (
        <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden bg-slate-950 text-white">
          <div
            className={`relative bg-slate-900 flex items-center justify-center ${
              dimensions === '9:16'
                ? 'aspect-[9/16] max-w-[220px] mx-auto'
                : dimensions === '1:1'
                ? 'aspect-square max-w-[300px] mx-auto'
                : 'aspect-video'
            }`}
          >
            {hasVideo ? (
              <video
                src={mediaUrl}
                controls
                muted
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center p-4 text-center bg-gradient-to-br from-slate-900 via-slate-800 to-slate-950">
                <div className="w-12 h-12 rounded-full bg-white/15 border border-white/25 flex items-center justify-center mb-2">
                  <Play className="w-5 h-5 text-white fill-white ml-0.5" />
                </div>
                <div className="text-xs font-medium text-slate-200">
                  Video Stream Stage ({dimensions || '16:9'})
                </div>
                <div className="text-[11px] text-slate-400 mt-0.5">
                  Upload MP4/WEBM or enter a video URL to preview playback
                </div>
              </div>
            )}
            <span className="absolute top-2 left-2 px-2 py-0.5 text-[10px] font-semibold bg-slate-950/80 text-white rounded">
              {spec.disclosureLabel} · {pricingModel}
            </span>
            {!hasVideo && (
              <div className="absolute inset-x-0 bottom-0 px-3 py-2 bg-slate-950/80 flex items-center gap-2 text-[10px] font-mono text-slate-300">
                <span>0:04 / 0:15</span>
                <div className="flex-1 h-1 rounded-full bg-slate-700 overflow-hidden">
                  <div className="w-1/3 h-full bg-blue-500" />
                </div>
                <Volume2 className="w-3.5 h-3.5 text-slate-300" />
              </div>
            )}
          </div>
          <div className="p-3.5 bg-slate-900 border-t border-slate-800">
            <div className="text-sm font-semibold text-white break-words">{headline}</div>
            <p className="mt-1 text-xs text-slate-300 leading-relaxed break-words">{copy}</p>
            <div className="mt-3 flex items-center justify-between gap-2">
              <span className="text-[11px] font-mono text-slate-400 truncate">{host}</span>
              <span className="px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 rounded whitespace-nowrap shrink-0">
                {cta}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* RESPONSIVE AD PREVIEW — Dual Desktop + Mobile adaptive preview */}
      {spec.format === 'responsive' && (
        <div className="space-y-3">
          <div className="border border-slate-200 dark:border-slate-800 rounded-lg p-3 bg-slate-50 dark:bg-slate-950">
            <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase text-slate-500 mb-2">
              <Monitor className="w-3 h-3" /> Desktop Horizontal Reflow
            </div>
            <div className="flex items-center gap-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md overflow-hidden pr-3">
              {hasImage && (
                <img
                  src={mediaUrl}
                  alt={headline}
                  referrerPolicy="no-referrer"
                  className="w-24 h-20 object-cover shrink-0"
                />
              )}
              <div className="min-w-0 flex-1 py-2 pl-2">
                <div className="text-[10px] text-slate-400">{spec.disclosureLabel} · {host}</div>
                <div className="text-xs font-semibold text-slate-900 dark:text-white truncate">{headline}</div>
                <div className="text-[11px] text-slate-600 dark:text-slate-300 truncate">{copy}</div>
              </div>
              <span className="px-2.5 py-1 text-[11px] font-semibold text-white bg-blue-700 rounded whitespace-nowrap shrink-0">
                {cta}
              </span>
            </div>
          </div>

          <div className="border border-slate-200 dark:border-slate-800 rounded-lg p-3 bg-slate-50 dark:bg-slate-950">
            <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase text-slate-500 mb-2">
              <Smartphone className="w-3 h-3" /> Mobile Feed Card Reflow
            </div>
            <div className="max-w-[260px] mx-auto bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md overflow-hidden">
              {hasImage && (
                <img
                  src={mediaUrl}
                  alt={headline}
                  referrerPolicy="no-referrer"
                  className="w-full h-28 object-cover"
                />
              )}
              <div className="p-2.5 space-y-1.5">
                <div className="text-xs font-semibold text-slate-900 dark:text-white break-words">{headline}</div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] font-mono text-slate-400 truncate">{host}</span>
                  <span className="px-2 py-0.5 text-[11px] font-semibold text-white bg-blue-700 rounded whitespace-nowrap">
                    {cta}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* SPONSORED CONTENT PREVIEW — Editorial Brand Story card */}
      {spec.format === 'sponsored' && (
        <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden bg-white dark:bg-slate-950">
          <div className="px-4 py-2 bg-amber-50/80 dark:bg-amber-950/30 border-b border-amber-200/70 dark:border-amber-900/50 flex items-center justify-between text-[11px]">
            <span className="inline-flex items-center gap-1.5 font-semibold text-amber-900 dark:text-amber-300">
              <BookOpen className="w-3.5 h-3.5" />
              {spec.disclosureLabel}
            </span>
            <span className="font-mono text-amber-800/80 dark:text-amber-400/80">2 min read</span>
          </div>
          {hasImage && (
            <div className="aspect-[1200/628] bg-slate-200 dark:bg-slate-800">
              <img
                src={mediaUrl}
                alt={headline}
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover"
              />
            </div>
          )}
          <div className="p-4 space-y-2">
            <div className="text-xs font-mono text-slate-500 dark:text-slate-400">
              Presented by {host}
            </div>
            <h4 className="text-base font-bold text-slate-900 dark:text-white leading-snug break-words">
              {headline}
            </h4>
            <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed break-words">
              {copy}
            </p>
            <div className="pt-2 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
              <span className="text-[11px] text-slate-400">Editorial placement · Looma Feed</span>
              <span className="text-xs font-semibold text-blue-700 dark:text-blue-400 inline-flex items-center gap-1">
                {cta} →
              </span>
            </div>
          </div>
        </div>
      )}

      {/* NATIVE AD PREVIEW — Seamless Looma feed card */}
      {spec.format === 'native' && (
        <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden bg-slate-50 dark:bg-slate-950">
          {hasImage && (
            <div className="aspect-[16/10] bg-slate-200 dark:bg-slate-800">
              <img
                src={mediaUrl}
                alt={headline}
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover"
              />
            </div>
          )}
          <div className="p-4">
            <div className="text-[11px] text-slate-500 dark:text-slate-400">{spec.disclosureLabel}</div>
            <div className="mt-1 text-base font-semibold text-slate-900 dark:text-white break-words">
              {headline}
            </div>
            <p className="mt-1 text-xs text-slate-600 dark:text-slate-300 leading-relaxed break-words">
              {copy}
            </p>
            <div className="mt-3 flex items-center justify-between gap-2 min-w-0">
              <span className="text-[11px] font-mono text-slate-400 truncate min-w-0 flex-1">{host}</span>
              <span className="px-3 py-1.5 text-xs font-medium text-white bg-blue-700 rounded-md whitespace-nowrap shrink-0">
                {cta}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Placement compatibility summary */}
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 p-3 text-xs space-y-1.5">
        <div className="flex items-start justify-between gap-3">
          <span className="text-slate-500 dark:text-slate-400 shrink-0">Eligible Placements</span>
          <span className="font-mono text-[11px] text-slate-800 dark:text-slate-200 text-right">
            {spec.compatiblePlacements.join(', ')}
          </span>
        </div>
        <div className="flex items-start justify-between gap-3">
          <span className="text-slate-500 dark:text-slate-400 shrink-0">Media Requirement</span>
          <span className="font-medium text-slate-800 dark:text-slate-200 text-right">
            {spec.mediaMode === 'none'
              ? 'No Media (Text-Only)'
              : spec.mediaMode === 'video'
              ? 'Video File / URL (MP4, WEBM)'
              : spec.mediaRequired
              ? 'Image Required'
              : 'Image Recommended (Optional)'}
          </span>
        </div>
        <div className="flex items-start justify-between gap-3">
          <span className="text-slate-500 dark:text-slate-400 shrink-0">Recommended Billing</span>
          <span className="font-mono text-[11px] text-slate-800 dark:text-slate-200 text-right">
            {spec.recommendedPricingModels.join(' · ')}
          </span>
        </div>
      </div>
    </div>
  );
};
