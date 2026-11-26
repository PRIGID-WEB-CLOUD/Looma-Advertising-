import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AD_FORMATS,
  AD_FORMAT_SPECS,
  DEFAULT_IMAGE_ASSET,
  applyFormatChange,
  getAdFormatSpec,
  updateTrackingParamMedium,
  validateCreativeForFormat,
} from './adFormats.js';

test('all 7 ad formats have complete specifications with valid default dimensions', () => {
  assert.equal(AD_FORMATS.length, 7);
  for (const format of AD_FORMATS) {
    const spec = getAdFormatSpec(format);
    assert.equal(spec.format, format);
    assert.ok(spec.label.length > 0);
    assert.ok(spec.compatiblePlacements.length > 0);
    assert.ok(
      spec.dimensionsOptions.some((opt) => opt.value === spec.defaultDimensions),
      `defaultDimensions for ${format} must exist in dimensionsOptions`
    );
  }
});

test('switching from native to text clears mediaUrl, sets dimensions to text, and updates utm_medium', () => {
  const updated = applyFormatChange(
    {
      format: 'native',
      dimensions: 'responsive',
      mediaUrl: DEFAULT_IMAGE_ASSET,
      pricingModel: 'CPC',
      ctaText: 'Explore Offer',
      trackingParams: 'utm_source=looma&utm_medium=native',
    },
    'text'
  );

  assert.equal(updated.format, 'text');
  assert.equal(updated.dimensions, 'text');
  assert.equal(updated.mediaUrl, '');
  assert.equal(updated.ctaText, AD_FORMAT_SPECS.text.defaultCta);
  assert.equal(updated.trackingParams, 'utm_source=looma&utm_medium=text');
});

test('switching from text to banner restores default image asset and sets IAB 728x90 dimensions', () => {
  const updated = applyFormatChange(
    {
      format: 'text',
      dimensions: 'text',
      mediaUrl: '',
      pricingModel: 'CPC',
      ctaText: 'Visit Site',
      trackingParams: 'utm_source=looma&utm_medium=text',
    },
    'banner'
  );

  assert.equal(updated.format, 'banner');
  assert.equal(updated.dimensions, '728x90');
  assert.equal(updated.mediaUrl, DEFAULT_IMAGE_ASSET);
  assert.equal(updated.ctaText, AD_FORMAT_SPECS.banner.defaultCta);
  assert.equal(updated.trackingParams, 'utm_source=looma&utm_medium=banner');
});

test('switching to video clears non-video image URL, switches default CPC to CPV, and sets 16:9 dimensions', () => {
  const updated = applyFormatChange(
    {
      format: 'native',
      dimensions: 'responsive',
      mediaUrl: DEFAULT_IMAGE_ASSET,
      pricingModel: 'CPC',
      ctaText: 'Explore Offer',
      trackingParams: 'utm_source=looma&utm_medium=native',
    },
    'video'
  );

  assert.equal(updated.format, 'video');
  assert.equal(updated.dimensions, '16:9');
  assert.equal(updated.mediaUrl, '');
  assert.equal(updated.pricingModel, 'CPV');
  assert.equal(updated.ctaText, AD_FORMAT_SPECS.video.defaultCta);
});

test('switching format while editing preserves custom CTA and pricing model', () => {
  const updated = applyFormatChange(
    {
      format: 'native',
      dimensions: 'responsive',
      mediaUrl: DEFAULT_IMAGE_ASSET,
      pricingModel: 'FIXED',
      ctaText: 'Book Demo Today',
      trackingParams: 'utm_source=looma&utm_medium=native&utm_campaign=q4',
    },
    'sponsored',
    { isEditing: true }
  );

  assert.equal(updated.format, 'sponsored');
  assert.equal(updated.dimensions, 'responsive');
  assert.equal(updated.pricingModel, 'FIXED');
  assert.equal(updated.ctaText, 'Book Demo Today');
  assert.equal(updated.trackingParams, 'utm_source=looma&utm_medium=sponsored&utm_campaign=q4');
});

test('updateTrackingParamMedium appends utm_medium if absent and preserves existing params', () => {
  assert.equal(updateTrackingParamMedium('', 'banner'), 'utm_source=looma&utm_medium=banner');
  assert.equal(
    updateTrackingParamMedium('utm_source=partner&ref=abc', 'image'),
    'utm_source=partner&ref=abc&utm_medium=image'
  );
});

test('validateCreativeForFormat enforces media requirements for banner/image and permits empty media for text', () => {
  assert.ok(
    validateCreativeForFormat({
      format: 'banner',
      title: 'Fast Cards',
      description: 'Instant spend controls',
      mediaUrl: '',
    })
  );
  assert.equal(
    validateCreativeForFormat({
      format: 'text',
      title: 'Fast Cards',
      description: 'Instant spend controls',
      mediaUrl: '',
    }),
    null
  );
  assert.ok(
    validateCreativeForFormat({
      format: 'image',
      title: 'Fast Cards',
      description: 'Instant spend controls',
      mediaUrl: '/api/media/demo.mp4',
    })
  );
});
