import { CID } from "multiformats/cid";

const LOCAL_GATEWAY_FALLBACK = "https://gateway.pinata.cloud";

export function pinataGatewayBaseUrl(
  configured: string | undefined,
  requireConfigured = false,
) {
  if (!configured && requireConfigured) {
    throw new Error("IPFS gateway is not configured.");
  }
  const url = new URL(configured || LOCAL_GATEWAY_FALLBACK);
  const hostname = url.hostname.toLowerCase();
  const trustedHost =
    hostname === "gateway.pinata.cloud" || hostname.endsWith(".mypinata.cloud");
  const path = url.pathname.replace(/\/+$/, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !trustedHost ||
    (path !== "" && path !== "/ipfs")
  ) {
    throw new Error("IPFS gateway configuration is invalid.");
  }
  return `${url.origin}/ipfs`;
}

export function ipfsCidFromUri(value: string) {
  if (!value.startsWith("ipfs://")) return null;
  const rawCid = value.slice("ipfs://".length);
  if (!rawCid || rawCid.includes("/") || rawCid.includes("?") || rawCid.includes("#")) {
    return null;
  }
  try {
    return CID.parse(rawCid).toV1().toString();
  } catch {
    return null;
  }
}

export function resolveIpfsGatewayUrl(options: {
  cid: string;
  configured?: string;
  requireConfigured?: boolean;
}) {
  const cid = CID.parse(options.cid).toV1().toString();
  return `${pinataGatewayBaseUrl(
    options.configured,
    options.requireConfigured ?? false,
  )}/${cid}`;
}

export function trustedIpfsGatewayUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const prefix = "/ipfs/";
  if (!url.pathname.startsWith(prefix) || url.pathname.includes("%")) return null;
  const rawCid = url.pathname.slice(prefix.length);
  if (!rawCid || rawCid.includes("/")) return null;
  let canonicalCid: string;
  try {
    canonicalCid = CID.parse(rawCid).toV1().toString();
  } catch {
    return null;
  }
  const hostname = url.hostname.toLowerCase();
  const trustedHost =
    hostname === "gateway.pinata.cloud" || hostname.endsWith(".mypinata.cloud");
  if (
    url.protocol !== "https:" ||
    !trustedHost ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    rawCid !== canonicalCid
  ) {
    return null;
  }
  return url.toString();
}
