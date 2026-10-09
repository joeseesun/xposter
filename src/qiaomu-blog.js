/* Qiaomu Blog is read-only here. No credentials are read or stored by xPoster. */
(() => {
  const ORIGIN = "https://blog.qiaomu.ai";
  const PERMISSION = `${ORIGIN}/*`;
  const PAGE_SIZE = 100;

  class BlogError extends Error {
    constructor(code) { super(code); this.code = code; }
  }

  function createClient(fetcher = globalThis.fetch) {
    async function request(params, signal) {
      const url = new URL("/api/posts", ORIGIN);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
      const response = await fetcher(url.href, {
        method: "GET", credentials: "include", cache: "no-store", redirect: "error",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000)
      });
      if (response.status === 401) throw new BlogError("login");
      if (response.status === 403) throw new BlogError("forbidden");
      if (!response.ok) throw new BlogError("unavailable");
      let data;
      try { data = await response.json(); } catch { throw new BlogError("invalid"); }
      if (data?.success !== true) throw new BlogError("invalid");
      return data;
    }
    return {
      async list(signal, onPage = () => {}) {
        const posts = [];
        const ids = new Set();
        for (let offset = 0; ; offset += PAGE_SIZE) {
          const data = await request({ limit: PAGE_SIZE, offset }, signal);
          if (!Array.isArray(data.posts) || data.posts.length > PAGE_SIZE) throw new BlogError("invalid");
          for (const post of data.posts) {
            if (!Number.isSafeInteger(post?.id) || post.id <= 0 || typeof post.title !== "string" ||
                !["draft", "published", "deleted"].includes(post.status)) throw new BlogError("invalid");
            // A repeated row means offset paging cannot safely claim a complete list.
            if (ids.has(post.id)) throw new BlogError("changed");
            ids.add(post.id);
            posts.push(post);
          }
          onPage(posts.length);
          if (data.posts.length < PAGE_SIZE) return posts;
          if (posts.length >= 100000) throw new BlogError("invalid");
        }
      },
      async get(id, signal) {
        if (!Number.isSafeInteger(id) || id <= 0) throw new BlogError("invalid");
        const data = await request({ id }, signal);
        if (data.post?.id !== id || typeof data.post.title !== "string") throw new BlogError("invalid");
        return data.post;
      }
    };
  }

  function postStatus(post) {
    return post.deleted_at || post.status === "deleted" ? "deleted" : post.status;
  }

  function filterPosts(posts, status = "all", query = "") {
    const needle = query.trim().toLocaleLowerCase();
    return posts.filter((post) => (status === "all" ? postStatus(post) !== "deleted" : postStatus(post) === status) &&
      (!needle || `${post.title} ${post.category || ""} ${post.slug || ""}`.toLocaleLowerCase().includes(needle)));
  }

  function publicUrl(value) {
    if (typeof value !== "string" || !value.trim()) return "";
    try {
      const url = new URL(value, ORIGIN);
      return ["http:", "https:"].includes(url.protocol) ? url.href : "";
    } catch { return ""; }
  }

  function articleDate(value) {
    if (!value) return "";
    const numeric = /^\d+$/.test(String(value)) ? Number(value) : null;
    const date = new Date(numeric !== null ? (numeric < 1e12 ? numeric * 1000 : numeric) : value);
    return Number.isFinite(date.getTime()) ? date.toLocaleDateString("sv-SE") : "";
  }

  function createConverter(Turndown, gfm) {
    const converter = new Turndown({
      headingStyle: "atx", bulletListMarker: "-", codeBlockStyle: "fenced",
      blankReplacement: (_content, node) => {
        const tweet = node.getAttribute?.("data-twitter-src");
        return tweet && publicUrl(tweet) ? `\n\n${publicUrl(tweet)}\n\n` : node.isBlock ? "\n\n" : "";
      }
    });
    converter.use(gfm);
    converter.remove(["script", "style", "noscript", "button", "input"]);
    converter.addRule("blogImage", {
      filter: "img",
      replacement: (_content, node) => {
        const src = publicUrl(node.getAttribute("src"));
        return src ? `![${(node.getAttribute("alt") || "").replace(/[\[\]\\]/g, "\\$&")}](${src.replace(/\(/g, "%28").replace(/\)/g, "%29")})` : "";
      }
    });
    converter.addRule("blogLink", {
      filter: (node) => node.nodeName === "A" && node.hasAttribute("href"),
      replacement: (content, node) => {
        const href = node.getAttribute("href");
        const url = href?.startsWith("#") ? href : publicUrl(href);
        return url ? `[${content}](${url.replace(/\(/g, "%28").replace(/\)/g, "%29")})` : content;
      }
    });
    converter.addRule("blogEmbed", {
      filter: (node) => node.nodeName === "DIV" && (node.hasAttribute("data-twitter-src") || node.hasAttribute("data-youtube-video")),
      replacement: (_content, node) => {
        const src = node.getAttribute("data-twitter-src") || node.querySelector("iframe")?.getAttribute("src");
        return src && publicUrl(src) ? `\n\n${publicUrl(src)}\n\n` : "";
      }
    });
    converter.addRule("blogMedia", {
      filter: ["audio", "video", "iframe"],
      replacement: (_content, node) => {
        const src = node.getAttribute("src") || node.querySelector("source")?.getAttribute("src");
        return src && publicUrl(src) ? `\n\n${publicUrl(src)}\n\n` : "";
      }
    });
    return (post) => {
      const title = String(post.title || "").replace(/[\r\n]+/g, " ").trim();
      // Blog's visual editor stores plain text in content; HTML retains images and formatting.
      let body = post.html?.trim() ? converter.turndown(post.html) : String(post.content || "").trim();
      if (!body.trim()) throw new BlogError("empty");
      const firstLine = body.split("\n")[0];
      if (firstLine.replace(/^#\s+/, "").trim() === title && /^#\s+/.test(firstLine)) body = body.slice(firstLine.length).trim();
      const cover = post.cover_image ? publicUrl(post.cover_image) : "";
      // JSON strings are valid YAML scalars and safely preserve punctuation in metadata.
      const frontmatter = `---\ntitle: ${JSON.stringify(title)}${cover ? `\ncover: ${JSON.stringify(cover)}` : ""}\n---`;
      return `${frontmatter}\n\n${body}\n`;
    };
  }

  function mount({ root, chromeApi, translate: t, onLoad, convert }) {
    const $ = (id) => root.querySelector(`#${id}`);
    const connect = $("blogConnect"), refresh = $("blogRefresh"), login = $("blogLogin");
    const status = $("blogStatus"), search = $("blogSearch"), list = $("blogList");
    const filters = [...root.querySelectorAll("[data-blog-filter]")];
    const client = createClient();
    let posts = [], selected = "all", busy = false, hydrated = false, loadingId = null, controller;
    const errors = {
      login: "Sign in to Qiaomu Blog, then refresh.",
      forbidden: "Blog access was refused. Open the blog and sign in, then refresh.",
      unavailable: "The blog is unavailable. Try refreshing later.",
      invalid: "The blog returned an unexpected response. Try refreshing.",
      changed: "The article list changed while loading. Refresh to load it again.",
      empty: "This article has no content to load.",
      writing: "Wait for the current X import to finish before loading another article.",
      full: "The pending queue is full. Remove a draft before loading another article.",
      large: "This article is too large to load into the pending queue."
    };
    function message(text, error = false) {
      status.textContent = text;
      status.dataset.tone = error ? "error" : "";
    }
    function render() {
      list.replaceChildren();
      const visible = filterPosts(posts, selected, search.value);
      for (const filter of filters) {
        filter.setAttribute("aria-pressed", String(filter.dataset.blogFilter === selected));
      }
      $("blogCount").textContent = posts.length ? `${visible.length} / ${posts.length}` : "";
      if (!visible.length && hydrated && !busy) message(t("No matching articles."));
      for (const post of visible) {
        const row = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "blog-post";
        button.dataset.blogId = String(post.id);
        button.disabled = busy || loadingId !== null;
        button.title = t("Load into xPoster");
        const title = document.createElement("strong");
        title.textContent = post.title || t("Untitled Markdown");
        const meta = document.createElement("span");
        const label = { draft: "Drafts", published: "Published", deleted: "Trash" }[postStatus(post)];
        const date = articleDate(post.published_at);
        meta.textContent = [t(label), post.is_hidden ? t("Hidden from blog list") : "", post.password ? t("Password protected") : "", post.category, date].filter(Boolean).join(" · ");
        const action = document.createElement("span");
        action.className = "blog-post-action";
        action.textContent = t(loadingId === post.id ? "Loading..." : "Load");
        button.append(title, meta, action);
        row.append(button);
        list.append(row);
      }
    }
    function failed(error) {
      login.hidden = !["login", "forbidden"].includes(error.code);
      message(t(errors[error.code] || (error.name === "TimeoutError" ? "The blog request timed out. Try refreshing." : "Could not connect to the blog. Try refreshing.")), true);
    }
    async function refreshPosts() {
      if (busy || loadingId !== null) return;
      if (!await chromeApi.permissions.contains({ origins: [PERMISSION] })) {
        connect.hidden = false;
        refresh.hidden = true;
        message(t("Connect to read your blog articles."));
        return;
      }
      connect.hidden = true;
      refresh.hidden = false;
      refresh.disabled = true;
      login.hidden = true;
      busy = true;
      posts = [];
      hydrated = false;
      render();
      message(t("Loading articles..."));
      controller = new AbortController();
      try {
        posts = await client.list(controller.signal, (count) => message(`${t("Loading articles...")} ${count}`));
        hydrated = true;
        message(t("Select an article to load into xPoster."));
      } catch (error) { failed(error); }
      finally { busy = false; refresh.disabled = false; render(); }
    }
    connect.addEventListener("click", async () => {
      try {
        if (await chromeApi.permissions.request({ origins: [PERMISSION] })) await refreshPosts();
        else message(t("Blog access was not granted. Connect again when ready."), true);
      } catch (error) { failed(error); }
    });
    refresh.addEventListener("click", () => void refreshPosts());
    login.addEventListener("click", () => void chromeApi.tabs.create({ url: `${ORIGIN}/admin` }));
    search.addEventListener("input", () => {
      if (hydrated && !busy && loadingId === null) message(t("Select an article to load into xPoster."));
      render();
    });
    filters.forEach((filter) => filter.addEventListener("click", () => {
      selected = filter.dataset.blogFilter;
      message(t("Select an article to load into xPoster."));
      render();
    }));
    list.addEventListener("click", async (event) => {
      const button = event.target.closest("button[data-blog-id]");
      if (!button || busy || loadingId !== null) return;
      loadingId = Number(button.dataset.blogId);
      refresh.disabled = true;
      render();
      message(t("Loading article..."));
      try {
        const post = await client.get(loadingId);
        await onLoad(convert(post), post);
        message(t("Article loaded. Review it in Pending before writing to X."));
      } catch (error) { failed(error); }
      finally { loadingId = null; refresh.disabled = false; render(); }
    });
    return {
      show() { if (!hydrated && !busy) void refreshPosts(); },
      translate() { render(); },
      dispose() { controller?.abort(); }
    };
  }

  const api = { ORIGIN, PERMISSION, BlogError, createClient, postStatus, filterPosts, publicUrl, articleDate, createConverter, mount };
  if (typeof window !== "undefined") window.xPosterBlog = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
