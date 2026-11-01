#!/usr/bin/env node
// Local HTTP contract tests through the real dispatchers; no external API or paid generation.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const home = await mkdtemp(join(tmpdir(), "gmm-toapis-"));
process.env.DSH_HOME = home;
const { normalizeConfig, saveConfig, maskConfig } =
  await import("../lib/config.js");
const {
  generateImageWithProvider,
  imageProviderBlocker,
  imageModelOf,
  imageSizeOf,
  imageRedrawModelOf,
  imageUsesConfiguredSize,
} = await import("../lib/imageprovider.js");
const { submitVideoTask, queryVideoTask, downloadVideoTask, videoBackendOf } =
  await import("../lib/videogen.js");
const { assertToapisModel, toapisRoot, downloadToapis } =
  await import("../lib/toapis.js");
const { createProject, patchProject, readProject } =
  await import("../lib/store.js");
const { createSequenceJob, writeSequenceJob, readSequenceJob } =
  await import("../lib/seqgen.js");
const { encodePng } = await import("../lib/png.js");
const png = encodePng(Buffer.from([255, 0, 0, 255]), 1, 1);
const mp4 = Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from("ftypisom"),
  Buffer.alloc(16),
]);
const dataUri = "data:image/png;base64," + png.toString("base64");
const requests = [],
  tasks = new Map();
let origin,
  sequence = 0,
  uploads = 0,
  mode = "normal";
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const path = new URL(req.url, "http://localhost").pathname;
  const json = (v, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(v));
  };
  const item = {
    path,
    method: req.method,
    auth: req.headers.authorization,
    raw,
  };
  requests.push(item);
  if (path === "/image.png" || path === "/video.mp4") {
    res.end(path.endsWith("png") ? png : mp4);
    return;
  }
  if (path === "/redirect") {
    res.writeHead(302, { location: origin + "/image.png" });
    res.end();
    return;
  }
  if (path === "/bad") {
    res.end("<html>not media</html>");
    return;
  }
  if (path === "/v1/uploads/images") {
    uploads++;
    json({
      data: { url: `https://cdn.example.test/reference-${uploads}.png` },
    });
    return;
  }
  if (req.method === "POST" && /\/generations$/.test(path)) {
    item.body = JSON.parse(raw);
    if (mode === "missing-id") {
      json({ status: "pending" });
      return;
    }
    const id = "task-" + ++sequence,
      kind = path.includes("/images/") ? "image" : "video";
    const task = {
      id,
      status: "pending",
      kind,
      mode,
      result: {
        data: [
          { url: origin + (kind === "image" ? "/image.png" : "/video.mp4") },
        ],
      },
    };
    tasks.set(id, task);
    json({ id, status: "pending" });
    return;
  }
  if (req.method === "GET" && path.includes("/generations/")) {
    const task = tasks.get(decodeURIComponent(path.split("/").at(-1)));
    if (!task) {
      json({}, 404);
      return;
    }
    json({
      ...task,
      status:
        task.mode === "pending"
          ? "processing"
          : task.mode === "fail"
            ? "failed"
            : "completed",
    });
    return;
  }
  json({}, 404);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
origin = "http://127.0.0.1:" + server.address().port;
let checks = 0;
function check(name, fn) {
  fn();
  checks++;
  console.log("PASS " + name);
}
async function reject(name, fn, pattern) {
  await assert.rejects(fn, pattern);
  checks++;
  console.log("PASS " + name);
}
const key = "private-test-key-never-return-to-browser";
const config = normalizeConfig({
  imageProvider: "toapis",
  toapisBaseUrl: origin + "/v1/",
  toapisApiKey: key,
  toapisVideo: true,
  toapisImageBackground: "transparent",
  toapisVideoAspectRatio: "1:1",
});
const postCount = () =>
  requests.filter((r) => r.method === "POST" && /\/generations$/.test(r.path))
    .length;
const image = (prompt, images = []) => ({
  prompt,
  images,
  size: "1024x768",
  watermark: false,
});
try {
  check("origin and /v1 normalization", () => {
    assert.equal(toapisRoot("https://toapis.cn/"), "https://toapis.cn/v1");
    assert.equal(toapisRoot("https://toapis.com/v1/"), "https://toapis.com/v1");
  });
  check("reject credential/query/path injection", () => {
    for (const url of [
      "https://key@toapis.com",
      "https://toapis.com/v1?key=x",
      "https://toapis.com/bad",
      "http://example.com",
    ])
      assert.throws(() => toapisRoot(url));
  });
  // 0.13.0 起生图后端只剩 ComfyUI（默认）与 ToAPIs，火山方舟的 `ark` 已删除。
  check("defaults preserve ComfyUI/MiniMax", () => {
    const c = normalizeConfig({});
    assert.equal(c.imageProvider, "comfyui");
    assert.equal(videoBackendOf(c), "minimax");
  });
  check("masked key never returned", () => {
    const c = maskConfig(config);
    assert.equal(c.toapisApiKey, undefined);
    assert.equal(c.toapisApiKeySet, true);
    assert(!JSON.stringify(c).includes(key));
  });
  check("ToAPIs does not require Ark/MiniMax keys", () => {
    assert.equal(imageProviderBlocker(config), undefined);
    assert.equal(imageModelOf(config), "gpt-image-2-vip");
    assert.equal(imageSizeOf(config), "1K");
  });
  check("missing ToAPIs key blocks dispatcher", () =>
    assert.match(imageProviderBlocker({ ...config, toapisApiKey: "" }), /Key/),
  );
  for (const model of [
    "seedance-2-global",
    "SEEDANCE_2_MINI_GLOBAL",
    "Seedance--2.5--Global",
  ])
    check("block disabled model " + model, () =>
      assert.throws(() => assertToapisModel(model), /disabled/),
    );
  await saveConfig(config);
  check("Ark redraw override never leaks into ToAPIs", () =>
    assert.equal(
      imageRedrawModelOf({ ...config, arkRedrawModel: "ark-only" }),
      "gpt-image-2-vip",
    ),
  );
  check("ToAPIs uses own configured size", () =>
    assert.equal(imageUsesConfiguredSize(config), true),
  );
  const { Context } = await import("@deepseek-ai/cordis");
  const plugin = await import("../lib/index.js");
  const ctx = new Context(),
    captured = [];
  ctx.provide("typert", { register: () => () => {} });
  ctx.provide("webServer", { register: () => () => {} });
  ctx.provide("tools", {
    register: (definition) => {
      captured.push(definition);
      return () => {};
    },
  });
  ctx.provide("systemPrompt", { section: () => () => {} });
  plugin.apply(ctx);
  const gateway = ctx.get("gameStudio"),
    view = await gateway.getConfig();
  check("host getConfig masks ToAPIs credentials", () =>
    assert(!JSON.stringify(view).includes(key)),
  );
  check("host preserves transparent background option", () => {
    assert.equal(view.toapisImageBackground, "transparent");
    assert.equal(normalizeConfig({toapisImageBackground:"invalid"}).toapisImageBackground, "auto");
  });
  check("host reports effective backend and model", () => {
    assert.equal(view.videoProviderBackend, "toapis");
    assert.equal(view.videoProviderModel, "seedance-2-mini");
    assert.equal(view.videoProviderBlocker, null);
  });
  const intake = await captured[0].execute(
    { action: "intake", module: "sequence" },
    { signal: undefined },
  );
  check("actual AI tool does not demand MiniMax key for ToAPIs", () =>
    assert(!intake.blockers.some((text) => text.includes("MiniMax"))),
  );
  check("actual AI tool describes ToAPIs parameters", () => {
    assert.equal(intake.known["视频模型"], "seedance-2-mini");
    assert.equal(intake.known["分辨率与时长档位"].duration, 4);
  });
  const result = await generateImageWithProvider(
    image("contract-image", [dataUri]),
  );
  check("real dispatcher returns validated image bytes", () => {
    assert.deepEqual(result.bytes, png);
    assert.equal(result.ext, "png");
    assert.equal(result.usage.taskId, "task-1");
  });
  const imagePost = requests.find((r) => r.body?.prompt === "contract-image");
  check("reference upload is multipart with Bearer", () => {
    const r = requests.find((r) => r.path === "/v1/uploads/images");
    assert.equal(r.auth, "Bearer " + key);
    assert.match(r.raw.toString(), /name="file"/);
  });
  check("exact image JSON mapping", () => {
    assert.equal(imagePost.body.size, "4:3");
    assert.equal(imagePost.body.resolution, "1K");
    assert.equal(imagePost.body.quality, "low");
    assert.equal(imagePost.body.background, "transparent");
    assert.equal(imagePost.body.n, 1);
    assert.equal(imagePost.body.watermark, undefined);
    assert.equal(
      imagePost.body.reference_images[0],
      "https://cdn.example.test/reference-1.png",
    );
  });
  check("API key used only on API routes", () =>
    assert(
      requests
        .filter((r) => !r.path.startsWith("/v1/"))
        .every((r) => r.auth === undefined),
    ),
  );
  const before = postCount();
  await generateImageWithProvider(image("contract-image", [dataUri]));
  check("successful delivery permits explicit regeneration", () =>
    assert.equal(postCount(), before + 1),
  );
  mode = "pending";
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 150);
  const beforeCancel = postCount();
  await reject(
    "caller cancellation interrupts polling",
    () =>
      generateImageWithProvider(image("resume-image", [dataUri]), abort.signal),
    /cancel|abort|receipt/i,
  );
  check("cancelled generation posted exactly once", () =>
    assert.equal(postCount(), beforeCancel + 1),
  );
  for (const t of tasks.values()) t.mode = "normal";
  mode = "normal";
  await generateImageWithProvider(image("resume-image", [dataUri]));
  check("resume existing ID despite changed upload URL", () =>
    assert.equal(postCount(), beforeCancel + 1),
  );
  mode = "missing-id";
  const beforeUnknown = postCount();
  await reject(
    "missing ID marks submission uncertain",
    () => generateImageWithProvider(image("unknown-submission")),
    /reconcile|Reconcile/,
  );
  mode = "normal";
  await reject(
    "uncertain POST never retried",
    () => generateImageWithProvider(image("unknown-submission")),
    /uncertain/,
  );
  check("uncertain submission single POST", () =>
    assert.equal(postCount(), beforeUnknown + 1),
  );
  const beforeBlocked = postCount();
  await saveConfig({ toapisImageModel: "SEEDANCE_2_GLOBAL" });
  await reject(
    "Global guard at real image dispatch",
    () => generateImageWithProvider(image("blocked-global")),
    /disabled/,
  );
  check("Global rejection has no paid POST", () =>
    assert.equal(postCount(), beforeBlocked),
  );
  await saveConfig({ toapisImageModel: "gpt-image-2-vip" });
  const video = await submitVideoTask(config, {
    prompt: "contract-video",
    firstFrameImage: dataUri,
    duration: 6,
    resolution: "1080P",
    promptOptimizer: true,
    model: "MiniMax-old-model",
  });
  check("video tagged ToAPIs and independent params", () => {
    assert.equal(video.backend, "toapis");
    const r = requests.find((r) => r.body?.prompt === "contract-video");
    assert.equal(r.body.model, "seedance-2-mini");
    assert.equal(r.body.duration, 4);
    assert.equal(r.body.resolution, "480p");
    assert.equal(r.body.aspect_ratio, "1:1");
    assert.equal(r.body.generate_audio, false);
    assert.equal(r.body.image_with_roles[0].role, "first_frame");
  });
  const switched = { ...config, toapisVideo: false, comfyVideo: true };
  const query = await queryVideoTask(switched, video.backend, video.taskId);
  check("persisted backend ignores current global switch", () => {
    assert.equal(query.status, "succeeded");
    assert.match(query.url, /video.mp4/);
  });
  const bytes = await downloadVideoTask(switched, video.backend, query.url);
  check("video downloaded without credentials", () => {
    assert.deepEqual(bytes, mp4);
    assert.equal(requests.find((r) => r.path === "/video.mp4").auth, undefined);
  });
  const project = await createProject("ToAPIs persistence test");
  await patchProject(project.id, (p) => {
    p.turn.video = {
      ...p.turn.video,
      status: "running",
      taskId: video.taskId,
      backend: "toapis",
    };
    p.videos.front = {
      ...p.videos.front,
      status: "running",
      taskId: video.taskId,
      backend: "toapis",
    };
  });
  const loaded = await readProject(project.id);
  check("both project video identities survive disk reload", () => {
    assert.equal(loaded.turn.video.backend, "toapis");
    assert.equal(loaded.videos.front.backend, "toapis");
  });
  const sequenceJob = await createSequenceJob("ToAPIs sequence persistence");
  check("sequence defaults show ToAPIs parameters", () => {
    assert.equal(sequenceJob.settings.model, "seedance-2-mini");
    assert.equal(sequenceJob.settings.duration, 4);
    assert.equal(sequenceJob.settings.resolution, "480p");
  });
  sequenceJob.video = {
    status: "running",
    backend: "toapis",
    taskId: video.taskId,
  };
  await writeSequenceJob(sequenceJob);
  const loadedSequence = await readSequenceJob(sequenceJob.id);
  check("sequence backend survives disk reload", () =>
    assert.equal(loadedSequence.video.backend, "toapis"),
  );
  const beforeInvalid = postCount();
  await reject(
    "unsupported last frame fails before submit",
    () =>
      submitVideoTask(config, {
        prompt: "unsupported",
        lastFrameImage: dataUri,
        duration: 4,
        resolution: "480p",
        promptOptimizer: false,
      }),
    /last-frame/,
  );
  await reject(
    "Global video guard before reference upload",
    () =>
      submitVideoTask(
        { ...config, toapisVideoModel: "seedance_2_mini_global" },
        {
          prompt: "blocked",
          firstFrameImage: dataUri,
          duration: 4,
          resolution: "480p",
          promptOptimizer: false,
        },
      ),
    /disabled/,
  );
  check("invalid video inputs do not bill", () =>
    assert.equal(postCount(), beforeInvalid),
  );
  const redirected = await downloadToapis(
    config,
    origin + "/redirect",
    "image",
  );
  check("redirect download still has no Bearer", () => {
    assert.deepEqual(redirected, png);
    assert.equal(
      requests.filter((r) => r.path === "/redirect").at(-1).auth,
      undefined,
    );
  });
  await reject(
    "HTML rejected as generated image",
    () => downloadToapis(config, origin + "/bad", "image"),
    /not a supported/,
  );
  await reject(
    "unsafe media URL rejected",
    () => downloadToapis(config, "http://169.254.169.254/metadata", "image"),
    /unsafe/,
  );
  const receiptDir = join(home, "game-material-master", "toapis-receipts");
  const receipts = await Promise.all(
    (await readdir(receiptDir)).map((name) =>
      readFile(join(receiptDir, name), "utf8"),
    ),
  );
  check("durable receipts contain no API key or base64 inputs", () =>
    assert(receipts.every((s) => !s.includes(key) && !s.includes(dataUri))),
  );
  const source = await readFile(
    new URL("../src/index.ts", import.meta.url),
    "utf8",
  );
  const whitelist = source.slice(
    source.indexOf("const directKeys = ["),
    source.indexOf("for (const key of directKeys)"),
  );
  check("secret excluded from host raw config whitelist", () => {
    assert(!whitelist.includes('"toapisApiKey"'));
    assert(whitelist.includes('"toapisBaseUrl"'));
  });
  console.log(`\nToAPIs: ${checks} checks passed (mock HTTP, zero paid calls)`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(home, { recursive: true, force: true });
}
