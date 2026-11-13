/**
 * illuci — Skill Registry Server
 *
 * Open-source skill library backend. Serves skill packages
 * via REST API. Filesystem-backed, zero dependencies beyond Node.js.
 *
 * Run locally:   node core/skills/registry-server.js [--port 8475]
 * Deploy:        illuci deploy --vercel (from this directory)
 *
 * API:
 *   GET  /index.json                  Full skill index (search/browse)
 *   GET  /skills/:name/skill.json     Skill manifest
 *   GET  /skills/:name/:file          Any file in the skill package
 *   GET  /skills/:name                Skill metadata + README
 *   POST /publish                     Upload a skill package (auth required)
 *   GET  /search?q=<query>&tags=<t>   Search skills
 *   GET  /stats                       Registry stats
 *   GET  /health                      Health check
 *
 * Storage: ./registry-data/skills/<name>/
 */

import http from "http";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "fs";
import { resolve, join, extname } from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const DATA_DIR = resolve(process.env.REGISTRY_DATA || __dirname, "registry-data");
const SKILLS_DIR = resolve(DATA_DIR, "skills");
const PORT = parseInt(process.env.REGISTRY_PORT || "8475");
const AUTH_TOKEN = process.env.REGISTRY_AUTH_TOKEN || null; // Set for write protection

// ─── INIT ───

mkdirSync(SKILLS_DIR, { recursive: true });

// ─── INDEX ───

function buildIndex() {
  const skills = [];

  for (const dir of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const manifestPath = resolve(SKILLS_DIR, dir.name, "skill.json");
    if (!existsSync(manifestPath)) continue;

    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      const stat = statSync(manifestPath);

      skills.push({
        name: manifest.name,
        version: manifest.version || "0.0.0",
        description: manifest.description || "",
        author: manifest.author || "anonymous",
        topology: manifest.topology || "direct",
        tags: manifest.tags || [],
        models: manifest.models || { compatible: "*" },
        license: manifest.license || "MIT",
        publishedAt: stat.mtime.toISOString(),
        downloads: manifest._downloads || 0,
      });
    } catch {}
  }

  return {
    registry: "illuci-skills",
    version: "1.0.0",
    skillCount: skills.length,
    updatedAt: new Date().toISOString(),
    skills,
  };
}

// ─── SEARCH ───

function searchSkills(query, tags) {
  const index = buildIndex();
  let results = index.skills;

  if (query) {
    const q = query.toLowerCase();
    results = results.filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.author.toLowerCase().includes(q) ||
      s.tags.some(t => t.toLowerCase().includes(q))
    );
  }

  if (tags && tags.length > 0) {
    results = results.filter(s =>
      tags.every(tag => s.tags.includes(tag))
    );
  }

  return results;
}

// ─── PUBLISH ───

function publishSkill(manifest, files) {
  if (!manifest.name || !manifest.version) {
    return { error: "Manifest must include name and version" };
  }

  // Validate name (alphanumeric + hyphens)
  if (!/^[a-z0-9-]+$/.test(manifest.name)) {
    return { error: "Skill name must be lowercase alphanumeric with hyphens only" };
  }

  const skillDir = resolve(SKILLS_DIR, manifest.name);
  mkdirSync(skillDir, { recursive: true });

  // Write manifest
  manifest._publishedAt = new Date().toISOString();
  manifest._downloads = 0;
  writeFileSync(resolve(skillDir, "skill.json"), JSON.stringify(manifest, null, 2));

  // Write additional files
  for (const [filename, content] of Object.entries(files || {})) {
    // Security: no path traversal
    const safe = filename.replace(/[\/\\\.\.]/g, "").replace(/^\.+/, "");
    if (safe && safe !== "skill.json") {
      writeFileSync(resolve(skillDir, safe), content);
    }
  }

  return { success: true, name: manifest.name, version: manifest.version };
}

// ─── HTTP ───

function parseBody(req) {
  return new Promise((res) => {
    let data = "";
    req.on("data", chunk => { data += chunk; });
    req.on("end", () => {
      try { res(JSON.parse(data)); } catch { res(null); }
    });
  });
}

function checkAuth(req) {
  if (!AUTH_TOKEN) return true; // No auth configured = open registry
  const header = req.headers.authorization || "";
  return header === `Bearer ${AUTH_TOKEN}`;
}

const MIME = {
  ".json": "application/json",
  ".js": "application/javascript",
  ".md": "text/markdown",
  ".txt": "text/plain",
};

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    // GET /health
    if (path === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", skills: readdirSync(SKILLS_DIR).length }));
      return;
    }

    // GET /stats
    if (path === "/stats") {
      const index = buildIndex();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        skills: index.skillCount,
        authors: [...new Set(index.skills.map(s => s.author))].length,
        topologies: [...new Set(index.skills.map(s => s.topology))].length,
        tags: [...new Set(index.skills.flatMap(s => s.tags))],
      }));
      return;
    }

    // GET /index.json
    if (path === "/index.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(buildIndex()));
      return;
    }

    // GET /search?q=...&tags=...
    if (path === "/search") {
      const q = url.searchParams.get("q") || "";
      const tags = url.searchParams.get("tags")?.split(",").filter(Boolean) || [];
      const results = searchSkills(q, tags);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ query: q, tags, results }));
      return;
    }

    // GET /skills/:name — skill metadata + README
    const skillMatch = path.match(/^\/skills\/([a-z0-9-]+)$/);
    if (skillMatch && req.method === "GET") {
      const name = skillMatch[1];
      const manifestPath = resolve(SKILLS_DIR, name, "skill.json");
      if (!existsSync(manifestPath)) { res.writeHead(404); res.end('{"error":"not found"}'); return; }

      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      const readmePath = resolve(SKILLS_DIR, name, "README.md");
      const readme = existsSync(readmePath) ? readFileSync(readmePath, "utf-8") : null;

      // Bump download count
      manifest._downloads = (manifest._downloads || 0) + 1;
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...manifest, readme }));
      return;
    }

    // GET /skills/:name/:file — serve any file in the package
    const fileMatch = path.match(/^\/skills\/([a-z0-9-]+)\/(.+)$/);
    if (fileMatch && req.method === "GET") {
      const [, name, file] = fileMatch;
      // Security: no traversal
      if (file.includes("..")) { res.writeHead(400); res.end('{"error":"invalid path"}'); return; }

      const filePath = resolve(SKILLS_DIR, name, file);
      if (!existsSync(filePath)) { res.writeHead(404); res.end('{"error":"not found"}'); return; }

      const ext = extname(file);
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
      res.end(readFileSync(filePath));
      return;
    }

    // POST /publish — upload a skill
    if (path === "/publish" && req.method === "POST") {
      if (!checkAuth(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"error":"unauthorized — set Authorization: Bearer <token>"}');
        return;
      }

      const body = await parseBody(req);
      if (!body || !body.manifest) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end('{"error":"body must include manifest and optional files"}');
        return;
      }

      const result = publishSkill(body.manifest, body.files || {});
      res.writeHead(result.error ? 400 : 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end('{"error":"not found"}');
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
});

// ─── START ───

server.listen(PORT, "0.0.0.0", () => {
  console.log(`illuci Skill Registry — http://0.0.0.0:${PORT}`);
  console.log(`  Skills:  ${SKILLS_DIR}`);
  console.log(`  Auth:    ${AUTH_TOKEN ? "enabled" : "open (no token)"}`);
  console.log(`\n  GET  /index.json            Browse all skills`);
  console.log(`  GET  /search?q=...          Search`);
  console.log(`  GET  /skills/:name          Skill metadata`);
  console.log(`  GET  /skills/:name/:file    Download file`);
  console.log(`  POST /publish               Upload (auth required)`);
  console.log(`  GET  /health                Health check`);
  console.log(`  GET  /stats                 Registry stats`);
});

process.on("SIGINT", () => { server.close(); process.exit(0); });
