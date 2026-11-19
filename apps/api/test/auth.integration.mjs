import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import express from "express";
import { Pool } from "pg";
import { createAuthRouter } from "../dist/auth/router.js";
import { createTestMailbox } from "../dist/auth/mailbox.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl)
  throw new Error(
    "Set TEST_DATABASE_URL to a disposable migrated PostgreSQL database.",
  );
const email = `phase06-${randomBytes(8).toString("hex")}@example.invalid`;
const password = "SyntheticPhase06Password!1";
const nextPassword = "SyntheticPhase06Password!2";
const origin = "http://localhost:5173";
const db = new Pool({ connectionString: databaseUrl, max: 4 });
const mailbox = createTestMailbox();
const app = express();
app.use(express.json());
app.use(
  "/api/v1/auth",
  createAuthRouter({
    db,
    sender: mailbox,
    jwtSecret: randomBytes(48).toString("base64url"),
    csrfSecret: randomBytes(48).toString("base64url"),
    frontendUrl: origin,
    production: false,
  }),
);
const server = createServer(app);

function jar() {
  const cookies = new Map();
  return {
    clone() {
      const copy = jar();
      for (const [key, value] of cookies) copy.cookies.set(key, value);
      return copy;
    },
    cookies,
    header() {
      return [...cookies].map(([key, value]) => `${key}=${value}`).join("; ");
    },
    absorb(response) {
      for (const value of response.headers.getSetCookie()) {
        const [pair] = value.split(";");
        const index = pair.indexOf("=");
        if (index < 0) continue;
        const key = pair.slice(0, index),
          content = pair.slice(index + 1);
        if (content) cookies.set(key, content);
        else cookies.delete(key);
      }
    },
  };
}

test("Phase 06 cookie auth, recovery, refresh races and revocation", async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/api/v1/auth`;
  const browser = jar();
  async function request(
    path,
    {
      method = "GET",
      body,
      client = browser,
      csrf,
      originHeader = origin,
      absorb = true,
    } = {},
  ) {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(client.header() ? { cookie: client.header() } : {}),
        ...(method !== "GET"
          ? {
              origin: originHeader,
              "x-csrf-token":
                csrf ?? client.cookies.get("fitness_dev_csrf") ?? "",
            }
          : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (absorb) client.absorb(response);
    return { status: response.status, body: await response.json(), response };
  }
  try {
    assert.equal((await request("/csrf")).status, 200);
    assert.equal(
      (
        await request("/register", {
          method: "POST",
          body: { email, password },
          originHeader: "https://wrong.invalid",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request("/register", {
          method: "POST",
          body: { email, password },
          csrf: "invalid",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request("/register", {
          method: "POST",
          body: { email, password, role: "admin" },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request("/register", {
          method: "POST",
          body: { email, password },
        })
      ).status,
      202,
    );
    assert.equal(
      (await request("/login", { method: "POST", body: { email, password } }))
        .status,
      401,
    );
    assert.equal(mailbox.messages.length, 1);
    const verify = new URL(mailbox.messages[0].url).searchParams.get("token");
    assert.equal((await request("/verify-email")).status, 200); // scanner does not consume
    assert.equal(
      (
        await request("/verify-email", {
          method: "POST",
          body: { token: verify },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request("/verify-email", {
          method: "POST",
          body: { token: verify },
        })
      ).status,
      400,
    );
    assert.equal(
      (await request("/login", { method: "POST", body: { email, password } }))
        .status,
      200,
    );
    assert.equal((await request("/me")).status, 200);
    assert.equal((await request("/admin-check")).status, 403);
    const original = browser.clone();
    const tab = original.clone();
    assert.equal(
      (await request("/refresh", { method: "POST", client: browser })).status,
      200,
    );
    // Simulate another tab and a lost response using the same old refresh cookie.
    assert.equal(
      (await request("/refresh", { method: "POST", client: tab })).status,
      200,
    );
    assert.equal(
      tab.cookies.get("fitness_dev_refresh"),
      browser.cookies.get("fitness_dev_refresh"),
    );
    assert.equal(
      (
        await request("/refresh", {
          method: "POST",
          client: original,
          absorb: false,
        })
      ).status,
      200,
    );
    browser.cookies.delete("fitness_dev_access"); // expired access with valid refresh
    assert.equal((await request("/csrf", { client: browser })).status, 200);
    assert.equal(
      (await request("/logout", { method: "POST", client: browser })).status,
      200,
    );
    assert.equal((await request("/me", { client: tab })).status, 401); // copied access is rejected immediately
    assert.equal(
      (await request("/refresh", { method: "POST", client: tab })).status,
      403,
    );

    assert.equal((await request("/csrf")).status, 200);
    assert.equal(
      (
        await request("/forgot-password", {
          method: "POST",
          body: { email: "absent@example.invalid" },
        })
      ).status,
      202,
    );
    assert.equal(
      (await request("/forgot-password", { method: "POST", body: { email } }))
        .status,
      202,
    );
    const reset = new URL(mailbox.messages.at(-1).url).searchParams.get(
      "token",
    );
    assert.equal((await request("/reset-password")).status, 200);
    assert.equal(
      (
        await request("/reset-password", {
          method: "POST",
          body: { token: reset, password: nextPassword },
        })
      ).status,
      200,
    );
    assert.equal((await request("/csrf")).status, 200);
    assert.equal(
      (
        await request("/reset-password", {
          method: "POST",
          body: { token: reset, password: nextPassword },
        })
      ).status,
      400,
    );
    assert.ok(browser.cookies.get("fitness_dev_csrf")); // invalid replay cannot clear a valid CSRF cookie
    assert.equal(
      (await request("/login", { method: "POST", body: { email, password } }))
        .status,
      401,
    );
    assert.equal(
      (
        await request("/login", {
          method: "POST",
          body: { email, password: nextPassword },
        })
      ).status,
      200,
    );
    const copied = browser.clone();
    const user = await db.query("SELECT id FROM users WHERE email=$1", [email]);
    await db.query("UPDATE sessions SET revoked_at=now() WHERE user_id=$1", [
      user.rows[0].id,
    ]);
    assert.equal((await request("/me", { client: copied })).status, 401);
    assert.throws(() => createTestMailbox(true), /forbidden/);
  } finally {
    await db.query("DELETE FROM users WHERE email=$1", [email]);
    await new Promise((resolve) => server.close(resolve));
    await db.end();
  }
});
