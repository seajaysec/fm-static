// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Chris Farrell
// Upstream template 0.3, published from fm1-base 934e40d846d84e76e9c428d37b74bccb6192c823.
// Its BSP is 2cd696a2b94341077303e9132bb4be3d0a87ebcf. No firmware is modified here.
import { inspect, APP_END } from "./fm1pkg.js?v=2026-10-26.21";

export const BRIDGE_PRODUCT = "FM-1_11000300";
export const BRIDGE_SHA256 = "a62e6d803b0fa223839d4af1eb558a4d02cc27b1f5c492e93b4a49beedc00538";
export const BRIDGE_URL = "https://raw.githubusercontent.com/charlesvestal/fm1-base/cb2baf68226d3eca38b3c1909423e029f0474626/firmware/template-0.3.fwsc";

export async function loadBridge() {
  const response = await fetch(BRIDGE_URL, { credentials: "omit" });
  if (!response.ok) throw new Error(`Could not fetch the temporary updater (HTTP ${response.status}). No installation started.`);
  const pkg = await inspect(await response.arrayBuffer());
  if (pkg.sha256 !== BRIDGE_SHA256 || pkg.product !== BRIDGE_PRODUCT || pkg.loader !== "app" || pkg.flashLen !== APP_END)
    throw new Error("The temporary updater does not match the reviewed file. No installation started.");
  return pkg;
}
