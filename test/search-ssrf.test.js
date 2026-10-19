'use strict';
// src/search.js: the private-address guard behind open_url (isPrivateIp,
// assertPublicHost) and the redirect loop that applies it to every hop
// (openUrl). DNS and global fetch are stubbed for each test and restored
// afterwards, so no network is used and no test depends on another.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const dns = require('dns').promises;
const { isPrivateIp, assertPublicHost, openUrl } = require('../src/search');

const PUBLIC_ADDR = [{ address: '93.184.216.34', family: 4 }];
const PRIVATE_REFUSAL = /open_url may not target a private or internal address/;

let realLookup, realFetch;
let lookedUp, dnsFor;  // dnsFor(hostname) returns addresses or throws; reset per test
let fetched, fetchFor; // fetchFor(url) returns a Response; reset per test

beforeEach(() => {
  realLookup = dns.lookup;
  realFetch = globalThis.fetch;
  lookedUp = [];
  dnsFor = () => PUBLIC_ADDR;
  dns.lookup = async (hostname) => { lookedUp.push(hostname); return dnsFor(hostname); };
  fetched = [];
  fetchFor = (url) => { throw new Error(`unexpected fetch of ${url}`); };
  globalThis.fetch = async (url, opts) => { fetched.push({ url: String(url), redirect: opts.redirect }); return fetchFor(String(url)); };
});

afterEach(() => {
  dns.lookup = realLookup;
  globalThis.fetch = realFetch;
});

// A response as fetch returns it: `url` is the address that was actually requested.
function htmlPage(url, html) {
  const res = new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  Object.defineProperty(res, 'url', { value: url });
  return res;
}

function redirectTo(location) {
  return new Response(null, { status: 302, headers: { location } });
}

describe('isPrivateIp', () => {
  it('treats the carrier-grade NAT range 100.64.0.0/10 as private, at both ends', () => {
    assert.equal(isPrivateIp('100.64.0.1'), true);
    assert.equal(isPrivateIp('100.127.255.255'), true);
  });

  it('treats the addresses just outside 100.64.0.0/10 as public', () => {
    assert.equal(isPrivateIp('100.63.0.1'), false);
    assert.equal(isPrivateIp('100.128.0.1'), false);
  });

  it('treats the IETF protocol assignments block 192.0.0.0/24 as private', () => {
    assert.equal(isPrivateIp('192.0.0.8'), true);
  });

  it('treats the benchmarking range 198.18.0.0/15 as private', () => {
    assert.equal(isPrivateIp('198.18.0.1'), true);
  });

  it('treats multicast and reserved space from 224.0.0.0 upward as private', () => {
    assert.equal(isPrivateIp('224.0.0.1'), true);
    assert.equal(isPrivateIp('255.255.255.255'), true);
  });

  it('treats an IPv4-mapped IPv6 address by the IPv4 address it carries, dotted or hex', () => {
    assert.equal(isPrivateIp('::ffff:10.0.0.1'), true);
    assert.equal(isPrivateIp('::ffff:a9fe:a9fe'), true, 'the cloud metadata address 169.254.169.254 in hex');
  });

  it('treats a NAT64 address by the IPv4 address it carries', () => {
    assert.equal(isPrivateIp('64:ff9b::7f00:1'), true, '127.0.0.1');
  });

  it('judges an IPv4-mapped or NAT64 address that carries a public IPv4 address as public', () => {
    assert.equal(isPrivateIp('::ffff:8.8.8.8'), false);
    assert.equal(isPrivateIp('64:ff9b::808:808'), false, '8.8.8.8');
  });

  it('treats IPv6 link-local fe80::/10 as private, including fe90::', () => {
    assert.equal(isPrivateIp('fe90::1'), true);
  });

  it('treats IPv6 multicast ff02::1 as private', () => {
    assert.equal(isPrivateIp('ff02::1'), true);
  });

  it('treats ordinary public addresses as public', () => {
    assert.equal(isPrivateIp('8.8.8.8'), false);
    assert.equal(isPrivateIp('2606:4700::1111'), false);
  });
});

describe('assertPublicHost', () => {
  it('refuses the IPv6 loopback given in brackets, without a DNS lookup', async () => {
    await assert.rejects(() => assertPublicHost('[::1]'), PRIVATE_REFUSAL);
    assert.deepEqual(lookedUp, []);
  });

  it('refuses an IPv4-mapped metadata address given in brackets', async () => {
    await assert.rejects(() => assertPublicHost('[::ffff:a9fe:a9fe]'), PRIVATE_REFUSAL);
  });

  it('refuses a name under .localhost without a DNS lookup', async () => {
    await assert.rejects(() => assertPublicHost('foo.localhost'), PRIVATE_REFUSAL);
    assert.deepEqual(lookedUp, []);
  });

  it('refuses a name whose DNS lookup fails', async () => {
    dnsFor = () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND nowhere.example'), { code: 'ENOTFOUND' }); };

    await assert.rejects(() => assertPublicHost('nowhere.example'), PRIVATE_REFUSAL);
  });

  it('refuses a name that resolves to no addresses at all', async () => {
    dnsFor = () => [];

    await assert.rejects(() => assertPublicHost('empty.example'), PRIVATE_REFUSAL);
  });

  it('refuses a name that resolves to a private address', async () => {
    dnsFor = () => [{ address: '10.1.2.3', family: 4 }];

    await assert.rejects(() => assertPublicHost('internal.example'), PRIVATE_REFUSAL);
  });

  it('refuses a name when any one of its addresses is private', async () => {
    dnsFor = () => [...PUBLIC_ADDR, { address: '127.0.0.1', family: 4 }];

    await assert.rejects(() => assertPublicHost('mixed.example'), PRIVATE_REFUSAL);
  });

  it('accepts a name that resolves only to public addresses', async () => {
    await assert.doesNotReject(() => assertPublicHost('public.example'));
    assert.deepEqual(lookedUp, ['public.example']);
  });
});

describe('openUrl redirect handling', () => {
  it('refuses a literal private start address without fetching it', async () => {
    await assert.rejects(() => openUrl('http://169.254.169.254/latest/meta-data/'), PRIVATE_REFUSAL);
    assert.deepEqual(fetched, []);
  });

  it('refuses a public page that redirects to the metadata address, and never fetches the metadata URL', async () => {
    fetchFor = (url) => {
      if (url === 'https://public.example/a') return redirectTo('http://169.254.169.254/latest');
      throw new Error(`unexpected fetch of ${url}`);
    };

    await assert.rejects(() => openUrl('https://public.example/a'), PRIVATE_REFUSAL);
    assert.deepEqual(fetched.map((f) => f.url), ['https://public.example/a']);
  });

  it('follows a public-to-public redirect and returns the final page, with the final address as its url', async () => {
    fetchFor = (url) => {
      if (url === 'https://public.example/a') return redirectTo('https://cdn.public.example/b');
      if (url === 'https://cdn.public.example/b') return htmlPage(url, '<html><head><title>Final</title></head><body><p>The final text.</p></body></html>');
      throw new Error(`unexpected fetch of ${url}`);
    };

    const page = await openUrl('https://public.example/a');

    assert.equal(page.blocked, false);
    assert.equal(page.url, 'https://cdn.public.example/b');
    assert.equal(page.title, 'Final');
    assert.match(page.text, /The final text\./);
    assert.deepEqual(fetched.map((f) => f.url), ['https://public.example/a', 'https://cdn.public.example/b']);
  });

  it('resolves a relative Location against the URL that redirected', async () => {
    fetchFor = (url) => {
      if (url === 'https://public.example/a') return redirectTo('/final');
      if (url === 'https://public.example/final') return htmlPage(url, '<p>Relative target.</p>');
      throw new Error(`unexpected fetch of ${url}`);
    };

    const page = await openUrl('https://public.example/a');

    assert.equal(page.url, 'https://public.example/final');
    assert.deepEqual(fetched.map((f) => f.url), ['https://public.example/a', 'https://public.example/final']);
  });

  it('refuses a redirect to a non-http scheme', async () => {
    fetchFor = () => redirectTo('file:///etc/passwd');

    await assert.rejects(() => openUrl('https://public.example/a'), /open_url only follows http\(s\) redirects/);
    assert.deepEqual(fetched.map((f) => f.url), ['https://public.example/a']);
  });

  it('sends every hop with redirect set to manual, so fetch never follows on its own', async () => {
    fetchFor = (url) => {
      if (url === 'https://public.example/a') return redirectTo('https://cdn.public.example/b');
      return htmlPage(url, '<p>Done.</p>');
    };

    await openUrl('https://public.example/a');

    assert.deepEqual(fetched.map((f) => f.redirect), ['manual', 'manual']);
  });

  it('follows exactly five redirects and returns the page that the sixth request reaches', async () => {
    const hops = new Map([
      ['https://public.example/r0', redirectTo('https://public.example/r1')],
      ['https://public.example/r1', redirectTo('https://public.example/r2')],
      ['https://public.example/r2', redirectTo('https://public.example/r3')],
      ['https://public.example/r3', redirectTo('https://public.example/r4')],
      ['https://public.example/r4', redirectTo('https://public.example/r5')],
      ['https://public.example/r5', htmlPage('https://public.example/r5', '<p>Five hops in.</p>')],
    ]);
    fetchFor = (url) => hops.get(url);

    const page = await openUrl('https://public.example/r0');

    assert.equal(page.blocked, false);
    assert.equal(page.url, 'https://public.example/r5');
    assert.equal(fetched.length, 6);
  });

  it('gives up with the redirect error on the sixth redirect, and does not request a seventh URL', async () => {
    const hops = new Map([
      ['https://public.example/r0', redirectTo('https://public.example/r1')],
      ['https://public.example/r1', redirectTo('https://public.example/r2')],
      ['https://public.example/r2', redirectTo('https://public.example/r3')],
      ['https://public.example/r3', redirectTo('https://public.example/r4')],
      ['https://public.example/r4', redirectTo('https://public.example/r5')],
      ['https://public.example/r5', redirectTo('https://public.example/r6')],
    ]);
    fetchFor = (url) => hops.get(url);

    await assert.rejects(() => openUrl('https://public.example/r0'), /open_url gave up after 5 redirects/);
    assert.deepEqual(fetched.map((f) => f.url), [
      'https://public.example/r0', 'https://public.example/r1', 'https://public.example/r2',
      'https://public.example/r3', 'https://public.example/r4', 'https://public.example/r5',
    ]);
  });
});
