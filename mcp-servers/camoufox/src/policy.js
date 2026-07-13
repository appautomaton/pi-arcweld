import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const blockedIpv4Ranges = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

const blockedIpv6Ranges = [
  ["::", 128],
  ["::1", 128],
  ["::", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2001:20::", 28],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
].map(([base, prefix]) => [ipv6ToBigInt(base), prefix]);

export function normalizeHostname(hostname) {
  return hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
}

function ipv4ToInt(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return;
  return parts.reduce((value, part) => value * 256 + part, 0) >>> 0;
}

function ipv4InCidr(address, base, prefix) {
  const value = ipv4ToInt(address);
  const baseValue = ipv4ToInt(base);
  if (value === undefined || baseValue === undefined) return false;
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (baseValue & mask);
}

function expandIpv6(address) {
  let input = normalizeHostname(address);
  const zone = input.indexOf("%");
  if (zone >= 0) input = input.slice(0, zone);

  if (input.includes(".")) {
    const lastColon = input.lastIndexOf(":");
    const ipv4 = input.slice(lastColon + 1);
    const value = ipv4ToInt(ipv4);
    if (lastColon < 0 || value === undefined) return;
    input = `${input.slice(0, lastColon)}:${((value >>> 16) & 0xffff).toString(16)}:${(value & 0xffff).toString(16)}`;
  }

  const sides = input.split("::");
  if (sides.length > 2) return;
  const head = sides[0] ? sides[0].split(":") : [];
  const tail = sides[1] ? sides[1].split(":") : [];
  if ([...head, ...tail].some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return;
  const missing = sides.length === 2 ? 8 - head.length - tail.length : 0;
  if (missing < 0 || (sides.length === 1 && head.length !== 8)) return;
  const parts = [...head, ...Array(missing).fill("0"), ...tail];
  return parts.length === 8 ? parts.map((part) => Number.parseInt(part, 16)) : undefined;
}

function ipv6ToBigInt(address) {
  const parts = expandIpv6(address);
  if (!parts) return;
  return parts.reduce((value, part) => (value << 16n) | BigInt(part), 0n);
}

function mappedIpv4(address) {
  const value = ipv6ToBigInt(address);
  if (value === undefined || (value >> 32n) !== 0xffffn) return;
  const ipv4 = Number(value & 0xffffffffn);
  return `${ipv4 >>> 24}.${(ipv4 >>> 16) & 255}.${(ipv4 >>> 8) & 255}.${ipv4 & 255}`;
}

export function isBlockedIp(address) {
  const normalized = normalizeHostname(address);
  const version = isIP(normalized);
  if (version === 4) return blockedIpv4Ranges.some(([base, prefix]) => ipv4InCidr(normalized, base, prefix));
  if (version !== 6) return true;

  const mapped = mappedIpv4(normalized);
  if (mapped) return isBlockedIp(mapped);
  const value = ipv6ToBigInt(normalized);
  if (value === undefined) return true;
  return blockedIpv6Ranges.some(([base, prefix]) => {
    const shift = 128n - BigInt(prefix);
    return (value >> shift) === (base >> shift);
  });
}

export function parseTargetUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("URL must be fully qualified.");
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("Only http and https URLs are allowed.");

  const hostname = normalizeHostname(url.hostname);
  if (!hostname) throw new Error("URL host is required.");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "local" || hostname.endsWith(".local")) {
    throw new Error("Local hostnames are not allowed.");
  }
  if (isIP(hostname) && isBlockedIp(hostname)) throw new Error("Private, local, or reserved IP addresses are not allowed.");
  return { url, hostname, needsDns: !isIP(hostname) };
}

export async function validateUrl(rawUrl) {
  const { url, hostname, needsDns } = parseTargetUrl(rawUrl);
  if (!needsDns) return url;

  let records;
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error("Could not resolve URL host.");
  }
  if (!records.length) throw new Error("URL host did not resolve to an address.");
  if (records.some(({ address }) => isBlockedIp(address))) {
    throw new Error("URL host resolves to a private, local, or reserved address.");
  }
  return url;
}

export function browserRequestUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol === "ws:") url.protocol = "http:";
  else if (url.protocol === "wss:") url.protocol = "https:";
  return url.toString();
}

export async function validateBrowserRequest(rawUrl) {
  return validateUrl(browserRequestUrl(rawUrl));
}
