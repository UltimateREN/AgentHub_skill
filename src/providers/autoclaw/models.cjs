/**
 * ============================================================
 *  作者：UltimateREN
 *  日期：2026-10-22
 *  版权声明：本代码归 UltimateREN 所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
"use strict";
const KNOWN_ROUTE_PREFIXES = ["zaicoding_", "zai_"];

const STATIC_MODELS = [
  {
    id: "glm-5.3",
    name: "GLM-5.3",
    routeId: "zaicoding_glm-5.3",
    rate: null,
    capabilities: { images: false, reasoning: true, tools: true },
    contextLength: 1048576,
    maxOutputTokens: 307200,
    routing: { routeId: "zaicoding_glm-5.3" },
  },
  {
    id: "glm-5.3-flash",
    name: "GLM-5.3-Flash",
    routeId: "zai_glm-5.3-flash",
    rate: null,
    capabilities: { images: true, reasoning: true, tools: true },
    contextLength: 1048576,
    maxOutputTokens: 131072,
    routing: { routeId: "zai_glm-5.3-flash" },
  },
];

const DEFAULT_ROUTE = "zai_auto";

function stripRoutePrefix(model) {
  const s = String(model || "");
  for (const p of KNOWN_ROUTE_PREFIXES) {
    if (s.startsWith(p)) return s.slice(p.length);
  }
  return s;
}

function isRouteId(s) {
  const m = /^[a-z][a-z0-9]*_[A-Za-z0-9._:-]{1,127}$/.exec(String(s || ""));
  return !!m;
}

function matchCatalogEntry(catalogModels, raw) {
  const key = String(raw || "").trim().toLowerCase();
  if (!key || !Array.isArray(catalogModels)) return null;
  for (const field of ["id", "name", "routeId"]) {
    for (const m of catalogModels) {
      if (!m) continue;
      const value = field === "routeId" ? (m.routing?.routeId ?? m.routeId) : m[field];
      if (String(value || "").trim().toLowerCase() === key) return m;
    }
  }
  return null;
}

function routeIdOf(entry) {
  return entry?.routing?.routeId ?? entry?.routeId;
}

function resolveRoute(raw, catalogModels) {
  const name = String(raw || "").trim();
  if (!name) return { routeModelId: DEFAULT_ROUTE, bodyModelId: stripRoutePrefix(DEFAULT_ROUTE) };
  const hit = matchCatalogEntry(catalogModels, name);
  const hitRoute = routeIdOf(hit);
  if (hit && hitRoute) {
    return { routeModelId: String(hitRoute), bodyModelId: stripRoutePrefix(hit.id || name) };
  }
  for (const p of KNOWN_ROUTE_PREFIXES) {
    if (name.startsWith(p)) return { routeModelId: name, bodyModelId: name.slice(p.length) };
  }
  if (isRouteId(name)) return { routeModelId: name, bodyModelId: stripRoutePrefix(name) };
  return { routeModelId: DEFAULT_ROUTE, bodyModelId: name };
}
module.exports = { KNOWN_ROUTE_PREFIXES, STATIC_MODELS, DEFAULT_ROUTE, stripRoutePrefix, isRouteId, matchCatalogEntry, resolveRoute, routeIdOf };
