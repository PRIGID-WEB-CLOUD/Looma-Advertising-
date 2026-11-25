import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FOOTER_PAGES,
  getFooterPageFromPath,
  getFooterPageMeta,
  getFooterPagesByCategory,
  getPathForFooterPage,
} from './footerRoutes';

test('all footer pages have unique slugs and canonical paths', () => {
  const slugs = new Set(FOOTER_PAGES.map((p) => p.slug));
  const paths = new Set(FOOTER_PAGES.map((p) => p.path));
  assert.equal(slugs.size, FOOTER_PAGES.length);
  assert.equal(paths.size, FOOTER_PAGES.length);
  assert.equal(FOOTER_PAGES.length, 12);
});

test('getFooterPageFromPath resolves canonical, trailing-slash, and uppercase paths', () => {
  assert.equal(getFooterPageFromPath('/privacy-policy'), 'privacy-policy');
  assert.equal(getFooterPageFromPath('/privacy-policy/'), 'privacy-policy');
  assert.equal(getFooterPageFromPath('/INTEGRATION-CONTRACT///'), 'integration-contract');
  assert.equal(getFooterPageFromPath('/gdpr-data-requests'), 'gdpr-data-requests');
  assert.equal(getFooterPageFromPath('/web-sdk'), 'web-sdk');
  assert.equal(getFooterPageFromPath('/rest-api'), 'rest-api');
  assert.equal(getFooterPageFromPath('/'), null);
  assert.equal(getFooterPageFromPath('/unknown-route'), null);
});

test('getPathForFooterPage and getFooterPagesByCategory partition all 3 footer categories', () => {
  assert.equal(getPathForFooterPage('advertiser-terms'), '/advertiser-terms');
  assert.equal(getFooterPageMeta('ad-quality-policy').category, 'Governance');
  assert.equal(getFooterPagesByCategory('Platform').length, 4);
  assert.equal(getFooterPagesByCategory('Developers').length, 4);
  assert.equal(getFooterPagesByCategory('Governance').length, 4);
});
