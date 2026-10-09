const { test } = require("node:test");
const assert = require("node:assert/strict");
const blog = require("../src/qiaomu-blog.js");
const shared = require("../src/shared.js");
const Turndown = require("turndown");
const { gfm } = require("turndown-plugin-gfm");
const convert = blog.createConverter(Turndown, gfm);
const post = (id, status = "draft") => ({ id, title: `Article ${id}`, status, slug: `article-${id}` });
const response = (data, status = 200) => ({ ok: status === 200, status, json: async () => data });

test("list reads all offset pages, including drafts and hidden articles, using GET and existing login", async () => {
  const calls = [];
  const client = blog.createClient(async (url, options) => {
    calls.push([new URL(url), options]);
    return response({ success: true, posts: calls.length === 1 ? Array.from({ length: 100 }, (_, i) => post(i + 1)) : [{ ...post(101, "published"), is_hidden: 1 }] });
  });
  const progress = [];
  const posts = await client.list(undefined, (count) => progress.push(count));
  assert.equal(posts.length, 101);
  assert.deepEqual(progress, [100, 101]);
  assert.equal(calls[1][0].searchParams.get("offset"), "100");
  for (const [url, options] of calls) {
    assert.equal(url.origin, blog.ORIGIN);
    assert.equal(url.pathname, "/api/posts");
    assert.equal(options.method, "GET");
    assert.equal(options.credentials, "include");
    assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store");
    assert.ok(!options.headers && !options.body);
  }
});

test("401, 403, invalid JSON and malformed lists never masquerade as an empty successful list", async () => {
  for (const [value, code] of [[response({}, 401), "login"], [response({}, 403), "forbidden"], [response({}, 500), "unavailable"], [response({ success: true, posts: [{ id: -1 }] }), "invalid"], [{ ok: true, status: 200, json: async () => { throw new Error("HTML login page"); } }, "invalid"]]) {
    await assert.rejects(blog.createClient(async () => value).list(), (error) => error.code === code);
  }
});

test("a failed later page or repeated offset page does not return a truncated complete list", async () => {
  const page = Array.from({ length: 100 }, (_, i) => post(i + 1));
  let calls = 0;
  await assert.rejects(blog.createClient(async () => ++calls === 1 ? response({ success: true, posts: page }) : response({}, 500)).list(), (e) => e.code === "unavailable");
  await assert.rejects(blog.createClient(async () => response({ success: true, posts: page })).list(), (e) => e.code === "changed");
});

test("detail fetch is by stable ID and refuses a different article", async () => {
  const client = blog.createClient(async (url) => {
    assert.equal(new URL(url).searchParams.get("id"), "42");
    return response({ success: true, post: { ...post(42), content: "latest text" } });
  });
  assert.equal((await client.get(42)).content, "latest text");
  await assert.rejects(client.get("../../secret"), (e) => e.code === "invalid");
  await assert.rejects(blog.createClient(async () => response({ success: true, post: post(43) })).get(42), (e) => e.code === "invalid");
});

test("filters distinguish hidden published posts from trash and search Chinese titles", () => {
  const posts = [{ ...post(1), title: "乔木草稿" }, { ...post(2, "published"), is_hidden: 1 }, { ...post(3, "published"), deleted_at: "2026-10-09" }, post(4, "deleted")];
  assert.deepEqual(blog.filterPosts(posts).map(p => p.id), [1, 2]);
  assert.deepEqual(blog.filterPosts(posts, "published").map(p => p.id), [2]);
  assert.deepEqual(blog.filterPosts(posts, "deleted").map(p => p.id), [3, 4]);
  assert.deepEqual(blog.filterPosts(posts, "draft", "乔木").map(p => p.id), [1]);
});

test("API Unix seconds and milliseconds render as dates instead of raw timestamps", () => {
  assert.equal(blog.articleDate(1791516430), "2026-10-09");
  assert.equal(blog.articleDate(1791516430000), "2026-10-09");
  assert.equal(blog.articleDate("not a date"), "");
});

test("visual blog HTML retains images, styles, GFM tables, embeds and canonical cover in xPoster", () => {
  const markdown = convert({
    title: "图文：\"测试\"", content: "plain text without images", cover_image: "/api/images/cover.png",
    html: '<h1>图文："测试"</h1><p><strong>粗体</strong>与<a href="/about">链接</a></p><img alt="图" src="/api/images/photo.gif"><table><thead><tr><th>列</th></tr></thead><tbody><tr><td>值</td></tr></tbody></table><div data-twitter-src="https://x.com/vista8/status/123"></div><video src="/media/clip.mp4"></video>'
  });
  assert.match(markdown, /\*\*粗体\*\*/);
  assert.match(markdown, /\[链接\]\(https:\/\/blog.qiaomu.ai\/about\)/);
  assert.match(markdown, /!\[图\]\(https:\/\/blog.qiaomu.ai\/api\/images\/photo.gif\)/);
  assert.match(markdown, /\| 列 \|/);
  assert.match(markdown, /https:\/\/x.com\/vista8\/status\/123/);
  assert.match(markdown, /https:\/\/blog.qiaomu.ai\/media\/clip.mp4/);
  assert.ok(!markdown.includes('plain text without images'));
  const parsed = shared.parseMarkdown(markdown);
  assert.equal(parsed.title, '图文："测试"');
  assert.equal(parsed.cover, "https://blog.qiaomu.ai/api/images/cover.png");
  assert.ok(parsed.segments.some(segment => segment.type === "image"));
  assert.ok(parsed.segments.some(segment => segment.type === "table"));
});

test("HTML conversion does not retain executable URLs or scripts; empty posts fail", () => {
  for (const value of [null, undefined, "", "   "]) assert.equal(blog.publicUrl(value), "");
  const markdown = convert({ title: "Safe", html: '<script>steal()</script><p>Hello <a href="javascript:steal()">link</a></p><img src="file:///etc/passwd"><img src="javascript:steal()">' });
  assert.ok(!/steal|javascript:|file:/.test(markdown));
  assert.match(markdown, /Hello link/);
  assert.throws(() => convert({ title: "Empty", html: "<p></p>" }), (e) => e.code === "empty");
  assert.match(convert({ title: "Plain", content: "Original **Markdown**" }), /Original \*\*Markdown\*\*/);
});
