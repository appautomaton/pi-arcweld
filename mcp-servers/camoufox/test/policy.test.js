import test from "node:test";
import assert from "node:assert/strict";
import { isBlockedIp, parseTargetUrl } from "../src/policy.js";

test("blocks local and reserved IP space", () => {
  for (const address of [
    "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254",
    "172.16.0.1", "192.31.196.1", "192.52.193.1", "192.168.1.1", "192.175.48.1",
    "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255",
    "::", "::1", "::127.0.0.1", "::ffff:127.0.0.1", "fc00::1", "fec0::1",
    "fe80::1", "ff02::1", "2001:db8::1", "3fff::1", "5f00::1",
  ]) assert.equal(isBlockedIp(address), true, address);
});

test("allows representative public IPs", () => {
  for (const address of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "2001:4860:4860::8888"])
    assert.equal(isBlockedIp(address), false, address);
});

test("accepts only public-looking HTTP(S) targets before DNS", () => {
  assert.equal(parseTargetUrl("https://example.com/path").url.hostname, "example.com");
  for (const url of ["file:///etc/passwd", "http://localhost", "http://foo.local", "http://127.0.0.1", "http://[::1]"])
    assert.throws(() => parseTargetUrl(url), url);
});
