import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowCounterClockwise, Check, Plus, SpinnerGap, Trash, UploadSimple, WarningCircle, X } from "@phosphor-icons/react";
import { apiFetch } from "./api.js";
import { reviewStageForJob } from "./import-job-state.js";
import { selectedImageFiles } from "./upload-image.js";
import { uploadLocalImage, uploadPayload, discardLocalUpload } from "./storage-upload.js";
import "./import-flow.css";

const API = "/api/import/jobs";
const CONFIG_API = "/api/import/config";
const PARTS = [
  ["upperbody", "上衣"],
  ["wholebody_up", "外套"],
  ["lowerbody", "下装"],
  ["accessories_up", "配饰"],
  ["shoes", "鞋履"],
];
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

async function requestJson(path, options, fallback = "请求失败，请稍后重试。") {
  const response = await apiFetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options?.headers || {}) },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(value.error || fallback);
    error.status = response.status;
    error.phase = value.phase;
    error.requestId = value.request_id;
    error.providerStatus = value.provider_status;
    error.providerResponseBody = value.provider_response_body;
    throw error;
  }
  return value;
}

const importJobRequest = (path, options) => requestJson(path, options, "无法更新导入任务。");

function deriveStatus(job) {
  const crop = job.stages?.crop;
  const garment = job.stages?.garment;
  const modeled = job.stages?.modeled;
  const reviewStage = reviewStageForJob(job);
  if (job.error || crop?.status === "failed" || garment?.status === "failed" || modeled?.status === "failed") return { tone: "error", text: "导入需要处理", detail: crop?.error || garment?.error || modeled?.error || job.error };
  if (reviewStage === "modeled") return { tone: "ready", text: "真人展示图等待审核" };
  if (modeled?.status === "processing") return { tone: "processing", text: "正在生成真人展示图" };
  if (reviewStage === "garment") return { tone: "ready", text: "单品图等待审核" };
  if (garment?.status === "approved") return { tone: "processing", text: "正在创建真人展示图" };
  if (reviewStage === "crop") return { tone: "ready", text: "裁剪结果等待审核" };
  if (crop?.status === "approved") return { tone: "processing", text: "正在创建单品图" };
  if (crop?.status === "rejected" || garment?.status === "rejected" || modeled?.status === "rejected") return { tone: "complete", text: "已拒绝导入" };
  return { tone: "processing", text: "正在识别图片中的衣物" };
}

function hasCleanupFailure(job) {
  return job.stages?.garment?.status === "failed" && Boolean(job.stages?.garment?.failedAssetUrl);
}

function defaultDraft(job) {
  const metadata = job.metadata || {};
  return {
    name: metadata.name || "新单品",
    part: metadata.part || "upperbody",
    color: metadata.color || "#d8d0c2",
    secondaryColor: metadata.secondaryColor || "",
    tags: Array.isArray(metadata.tags) ? metadata.tags.join(", ") : (metadata.tags || ""),
  };
}

function ReviewEditor({ job, stage, draft, setDraft, regenPrompt, setRegenPrompt, busy, onAction }) {
  const asset = job.stages[stage]?.assetUrl;
  const isCrop = stage === "crop";
  const isGarment = stage === "garment";
  const primaryValid = HEX_COLOR.test(draft.color);
  const secondaryValid = !draft.secondaryColor || HEX_COLOR.test(draft.secondaryColor);
  return (
    <div className="import-editor">
      <img className="import-editor__preview" src={asset} alt={isCrop ? "检测到的衣物裁剪图" : isGarment ? "提取后的单品图" : "生成的真人展示图"} />
      <div className="import-fields">
        <p className="import-editor__stage">{isCrop ? "识别与裁剪" : isGarment ? "干净单品图" : "真人展示图"}</p>
        {isCrop ? <p className="import-card__detail">{job.detectionFallback ? "AI 没有稳定定位到单件衣物，因此保留了整张图片。确认后仍会继续提取并生成干净单品图。" : "请确认裁剪图包含完整的目标衣物。批准后将开始生成干净单品图。"}</p> : isGarment ? (
          <>
            <div className="import-field"><label htmlFor={`name-${job.id}`}>名称</label><input id={`name-${job.id}`} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></div>
            <div className="import-field"><label htmlFor={`part-${job.id}`}>分类</label><select id={`part-${job.id}`} value={draft.part} onChange={(event) => setDraft({ ...draft, part: event.target.value })}>{PARTS.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></div>
            <div className="import-field"><label htmlFor={`primary-${job.id}`}>主色</label><div className="import-color-row"><input id={`primary-${job.id}`} type="color" value={primaryValid ? draft.color : "#000000"} onChange={(event) => setDraft({ ...draft, color: event.target.value })} /><input aria-label="主色十六进制值" aria-invalid={!primaryValid} value={draft.color} onChange={(event) => setDraft({ ...draft, color: event.target.value })} /></div>{!primaryValid && <small className="import-field-error">请输入六位十六进制颜色，例如 #d8d0c2。</small>}</div>
            <div className="import-field"><label htmlFor={`secondary-${job.id}`}>辅助色 <span>可选</span></label><input id={`secondary-${job.id}`} type="text" aria-invalid={!secondaryValid} placeholder="#颜色值或留空" value={draft.secondaryColor} onChange={(event) => setDraft({ ...draft, secondaryColor: event.target.value })} />{!secondaryValid && <small className="import-field-error">请输入六位十六进制颜色，或将此项留空。</small>}</div>
            <div className="import-field"><label htmlFor={`tags-${job.id}`}>细节标签</label><input id={`tags-${job.id}`} value={draft.tags} placeholder="休闲, 棉质, 条纹" onChange={(event) => setDraft({ ...draft, tags: event.target.value })} /></div>
          </>
        ) : <p className="import-card__detail">批准后会把这张真人展示图关联到新单品；也可以填写更具体的要求重新生成。</p>}
        {!isCrop && <div className="import-field import-regenerate-field">
          <label htmlFor={`regenerate-${job.id}-${stage}`}>重新生成要求 <span>可选</span></label>
          <textarea id={`regenerate-${job.id}-${stage}`} rows="3" value={regenPrompt} onChange={(event) => setRegenPrompt(event.target.value)} placeholder={isGarment ? "例如：保留原来的拉链并移除零售标签" : "例如：使用安静的夜晚街道并完整展示衣物"} />
        </div>}
        <div className="import-actions">
          <button className="import-button" disabled={busy} onClick={() => onAction("reject")}><Trash size={14} /> 拒绝</button>
          {!isCrop && <button className="import-button" disabled={busy} onClick={() => onAction("regenerate", regenPrompt)}><ArrowCounterClockwise size={14} /> 重新生成</button>}
          <button className="import-button import-button--primary" disabled={busy || (isGarment && (!draft.name.trim() || !primaryValid || !secondaryValid))} onClick={() => onAction("approve")}><Check size={14} weight="bold" /> {isCrop ? "使用此裁剪" : "批准"}</button>
        </div>
      </div>
    </div>
  );
}

function CleanupEditor({ job, tolerance, setTolerance, busy, onPreview, onAccept }) {
  const stage = job.stages.garment;
  const contaminated = stage.cleanupDiagnostics?.contaminatedPixels;
  const previewTimer = useRef(null);
  useEffect(() => () => clearTimeout(previewTimer.current), []);
  const updateTolerance = (next) => {
    setTolerance(next);
    clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => onPreview(next), 300);
  };
  return (
    <div className="import-cleanup-editor">
      <p className="import-editor__stage">背景清理</p>
      <p className="import-card__detail">下方保留了生成的原始单品图。这里的调整只在本地进行，不会再次调用图片模型。</p>
      <div className="import-cleanup-comparison">
        <figure><img src={stage.failedAssetUrl} alt="带纯色背景的生成单品图" /><figcaption>生成原图</figcaption></figure>
        <figure><img src={stage.cleanupPreviewUrl || stage.failedAssetUrl} alt="透明背景清理预览" /><figcaption>{stage.cleanupPreviewUrl ? "清理预览" : "预览会显示在这里"}</figcaption></figure>
      </div>
      <div className="import-field import-cleanup-strength">
        <label htmlFor={`cleanup-${job.id}`}>清理强度 <strong>{tolerance}</strong></label>
        <input id={`cleanup-${job.id}`} type="range" min="18" max="110" step="2" value={tolerance} onChange={(event) => updateTolerance(Number(event.target.value))} />
        <div className="import-cleanup-scale"><span>保留更多边缘细节</span><span>移除更多背景</span></div>
      </div>
      {Number.isFinite(contaminated) && <p className="import-card__detail">自动检查发现 {contaminated.toLocaleString()} 个带色边缘像素。如果预览看起来干净，仍然可以继续使用。</p>}
      <div className="import-actions">
        <button className="import-button" disabled={busy} onClick={() => onPreview(tolerance)}><ArrowCounterClockwise size={14} /> 预览清理效果</button>
        <button className="import-button import-button--primary" disabled={busy} onClick={onAccept}><Check size={14} weight="bold" /> 使用此清理结果</button>
      </div>
    </div>
  );
}

function ManualEditor({ item, draft, setDraft, busy, onSave, onDelete }) {
  return (
    <div className="import-editor">
      <img className="import-editor__preview" src={item.previewUrl} alt="衣物原始上传图片" />
      <div className="import-fields">
        <p className="import-editor__stage">衣物图片</p>
        <p className="import-card__detail">这条路径不会调用 AI。你可以填写任意信息，也可以留空后直接保存。</p>
        <div className="import-field"><label htmlFor={`manual-name-${item.id}`}>名称 <span>可选</span></label><input id={`manual-name-${item.id}`} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="未命名单品" /></div>
        <div className="import-field"><label htmlFor={`manual-part-${item.id}`}>分类 <span>可选</span></label><select id={`manual-part-${item.id}`} value={draft.part} onChange={(event) => setDraft({ ...draft, part: event.target.value })}><option value="">未分类</option>{PARTS.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></div>
        <div className="import-field"><label htmlFor={`manual-color-${item.id}`}>主色 <span>可选</span></label><input id={`manual-color-${item.id}`} value={draft.color} onChange={(event) => setDraft({ ...draft, color: event.target.value })} placeholder="#颜色值，或留空" /></div>
        <div className="import-field"><label htmlFor={`manual-secondary-${item.id}`}>辅助色 <span>可选</span></label><input id={`manual-secondary-${item.id}`} value={draft.secondaryColor} onChange={(event) => setDraft({ ...draft, secondaryColor: event.target.value })} placeholder="#颜色值，或留空" /></div>
        <div className="import-field"><label htmlFor={`manual-tags-${item.id}`}>细节标签 <span>可选</span></label><input id={`manual-tags-${item.id}`} value={draft.tags} onChange={(event) => setDraft({ ...draft, tags: event.target.value })} placeholder="休闲, 棉质, 条纹" /></div>
        <div className="import-actions"><button className="import-button" disabled={busy} onClick={onDelete}><Trash size={14} /> 移除</button><button className="import-button import-button--primary" disabled={busy} onClick={onSave}><Check size={14} weight="bold" /> 保存到我的衣橱</button></div>
      </div>
    </div>
  );
}

function ManualWardrobeImportFlow({ onGarmentApproved, enabled }) {
  const inputRef = useRef(null);
  const [items, setItems] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState("");

  const submitFiles = useCallback(async (files) => {
    const images = selectedImageFiles(files);
    setOpen(true);
    if (!images.length) { setError("请选择图片文件。"); return; }
    setError(""); setPreparing(true);
    const added = [];
    for (const file of images) {
      try {
        const id = `manual-${crypto.randomUUID()}`;
        const uploaded = await uploadLocalImage(file, "wardrobe");
        added.push({ id, name: file.name, uploadId: uploaded.uploadId, previewUrl: URL.createObjectURL(file) });
      } catch (requestError) { setError(requestError.message); }
    }
    if (added.length) {
      setItems((current) => [...current, ...added]);
      setDrafts((current) => ({ ...current, ...Object.fromEntries(added.map((item) => [item.id, { name: "", part: "", color: "", secondaryColor: "", tags: "" }])) }));
    }
    setPreparing(false);
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    const drop = event => { const files = selectedImageFiles(event.dataTransfer?.files); if (files.length) { event.preventDefault(); void submitFiles(files); } };
    const over = event => { if (event.dataTransfer?.types.includes("Files")) event.preventDefault(); };
    const paste = event => { const files = selectedImageFiles(event.clipboardData?.files); if (files.length) { event.preventDefault(); void submitFiles(files); } };
    window.addEventListener("drop", drop); window.addEventListener("dragover", over); window.addEventListener("paste", paste);
    return () => { window.removeEventListener("drop", drop); window.removeEventListener("dragover", over); window.removeEventListener("paste", paste); };
  }, [enabled, submitFiles]);

  const active = items[items.length - 1];
  const draft = active ? drafts[active.id] : null;
  const remove = (id) => {
    const removed = items.find((item) => item.id === id);
    if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
    setItems((current) => current.filter((item) => item.id !== id));
    setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)));
    if (items.length <= 1) setOpen(false);
  };
  const save = async () => {
    if (!active || !draft) return;
    setBusyId(active.id); setError("");
    try {
      const metadata = { ...draft, tags: draft.tags };
      const saved = await requestJson("/api/import/wardrobe", { method: "POST", body: JSON.stringify(uploadPayload(active.uploadId, metadata)) }, "图片已上传，但衣物保存失败，请重试。");
      onGarmentApproved?.(saved);
      remove(active.id);
    } catch (requestError) {
      setError(requestError.message);
    }
    finally { setBusyId(null); }
  };

  return (
    <>
      <input ref={inputRef} type="file" accept="image/*" multiple hidden onChange={(event) => { const files = Array.from(event.currentTarget.files || []); event.currentTarget.value = ""; void submitFiles(files); }} />
      <aside className={`import-tray${items.length ? " is-expanded" : ""}`} aria-label="衣橱导入">
        <button className="import-tray__button" type="button" onClick={() => items.length ? setOpen(true) : inputRef.current?.click()} aria-label="添加衣物"><Plus size={19} /></button>
        <div className="import-tray__actions"><span className="import-tray__label">添加衣物</span><button className="import-icon-button" type="button" onClick={() => inputRef.current?.click()} aria-label="选择图片"><UploadSimple size={17} /></button></div>
      </aside>
      <div className="import-popover-backdrop" data-open={open} onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
        <section className="import-popover" role="dialog" aria-modal="true" aria-labelledby="manual-import-title">
          <header className="import-popover__header"><div><p className="import-popover__eyebrow">衣橱导入</p><h2 className="import-popover__title" id="manual-import-title">手动添加衣物</h2></div><button className="import-icon-button" type="button" onClick={() => setOpen(false)} aria-label="关闭导入进度"><X size={20} /></button></header>
          {!active ? preparing ? <div className="import-drop-target"><SpinnerGap size={28} className="import-spinner" /><h2>正在上传图片</h2><p>正在将照片直接上传到你的 本机。</p></div> : <div className="import-drop-target"><UploadSimple size={28} /><h2>选择或粘贴图片</h2><p>图片会直接保存到你的衣橱，不会调用 AI。</p><button className="import-button import-button--primary" onClick={() => inputRef.current?.click()}>选择图片</button></div> : <><ManualEditor item={active} draft={draft} setDraft={(next) => setDrafts((current) => ({ ...current, [active.id]: next }))} busy={busyId === active.id} onSave={save} onDelete={() => { void discardLocalUpload(active.uploadId, "wardrobe"); remove(active.id); }} /><div className="import-actions"><button className="import-button" onClick={() => inputRef.current?.click()}><Plus size={14} /> 继续添加</button></div></>}
          {error && <p className="import-status is-error" role="alert">{error}</p>}
        </section>
      </div>
    </>
  );
}

function AiWardrobeImportFlow({ onGarmentApproved, onModeledApproved, enabled }) {
  const inputRef = useRef(null);
  const [jobs, setJobs] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [regenerationPrompts, setRegenerationPrompts] = useState({});
  const [cleanupTolerances, setCleanupTolerances] = useState({});
  const [dragging, setDragging] = useState(false);
  const [open, setOpen] = useState(false);
  const [selectedReviewId, setSelectedReviewId] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(null);
  const [setup, setSetup] = useState(null);
  const actionLocks = useRef(new Set());

  useEffect(() => {
    importJobRequest(CONFIG_API).then(setSetup).catch((requestError) => setSetup({ ready: false, error: requestError.message }));
    importJobRequest(API)
      .then((storedJobs) => {
        const visibleJobs = storedJobs.filter((job) => job.status !== "complete" && job.stages?.crop?.status !== "rejected" && job.stages?.garment?.status !== "rejected" && job.stages?.modeled?.status !== "rejected");
        setJobs(visibleJobs);
        setDrafts(Object.fromEntries(visibleJobs.map((job) => [job.id, defaultDraft(job)])));
      })
      .catch(() => {});
  }, []);

  const refresh = useCallback(async (id) => {
    try {
      const next = await importJobRequest(`${API}/${id}`);
      setJobs((current) => current.map((job) => job.id === id ? next : job));
      setDrafts((current) => current[id] ? current : { ...current, [id]: defaultDraft(next) });
    } catch (requestError) {
      if (requestError.status === 404) {
        setJobs((current) => current.filter((job) => job.id !== id));
        setNotice({ tone: "error", text: "导入任务已失效", detail: "任务状态已从云端移除，请重新选择图片。" });
        setOpen(true);
      } else {
        setError(requestError.message);
      }
    }
  }, []);

  useEffect(() => {
    if (!jobs.some((job) => (job.stages?.crop?.status === "approved" && ["processing", "pending", "queued"].includes(job.stages?.garment?.status)) || ["processing", "queued"].includes(job.stages?.modeled?.status) || (job.stages?.garment?.status === "approved" && job.stages?.modeled?.status === "pending"))) return undefined;
    const timer = setInterval(() => jobs.forEach((job) => refresh(job.id)), 900);
    return () => clearInterval(timer);
  }, [jobs, refresh]);

  const submitFiles = useCallback(async (files) => {
    const images = selectedImageFiles(files);
    setOpen(true);
    if (!images.length) { setError("请选择图片文件。"); return; }
    setDragging(false); setError(""); setNotice(null); setPreparing(true);
    let resolvedSetup = setup;
    try {
      if (!resolvedSetup?.ready) {
        resolvedSetup = await importJobRequest(CONFIG_API);
        setSetup(resolvedSetup);
      }
      if (!resolvedSetup?.ready) {
        setError(resolvedSetup?.error || "AI 导入服务尚未准备好，请稍后重试。");
        return;
      }
    for (const file of images) {
      let uploaded;
      try {
        uploaded = await uploadLocalImage(file, "jobs");
      } catch (storageError) {
        setError(storageError.message);
        continue;
      }
      try {
        const result = await importJobRequest(API, { method: "POST", body: JSON.stringify(uploadPayload(uploaded.uploadId, { name: file.name.replace(/\.[^.]+$/, "") })) });
        const createdJobs = result.jobs || [result];
        if (!createdJobs.length && result.noClothingDetected) {
          setNotice({ tone: "complete", text: "没有识别到衣物", detail: `无法在 ${file.name} 中找到清晰的可穿戴单品，请尝试更清楚或构图更紧凑的图片。` });
          setOpen(true);
          continue;
        }
        setJobs((current) => [...current, ...createdJobs]);
        setDrafts((current) => ({ ...current, ...Object.fromEntries(createdJobs.map((job) => [job.id, defaultDraft(job)])) }));
        if (result.usedFullImageFallback) {
          setNotice({ tone: "ready", text: "请确认整张图片", detail: "AI 没有稳定定位到单件衣物，已保留整张图片继续裁切审核。" });
        }
      } catch (requestError) {
        console.error("AI import job request failed after 本机 upload", {
          message: requestError.message,
          status: requestError.status,
          phase: requestError.phase,
          requestId: requestError.requestId,
          providerStatus: requestError.providerStatus,
        });
        setError(`AI 导入失败：${requestError.message}`);
      }
    }
    } catch (requestError) { setError(requestError.message); }
    finally { setPreparing(false); }
  }, [setup]);

  useEffect(() => {
    if (!enabled) return undefined;
    let depth = 0;
    const onDragEnter = (event) => { if (![...event.dataTransfer.types].includes("Files")) return; event.preventDefault(); depth += 1; setDragging(true); };
    const onDragOver = (event) => { if ([...event.dataTransfer.types].includes("Files")) event.preventDefault(); };
    const onDragLeave = (event) => { event.preventDefault(); depth = Math.max(0, depth - 1); if (!depth) setDragging(false); };
    const onDrop = (event) => { event.preventDefault(); depth = 0; setDragging(false); submitFiles(event.dataTransfer.files); };
    const onPaste = (event) => { const files = [...event.clipboardData.files]; if (files.some((file) => file.type.startsWith("image/"))) { event.preventDefault(); submitFiles(files); } };
    window.addEventListener("dragenter", onDragEnter); window.addEventListener("dragover", onDragOver); window.addEventListener("dragleave", onDragLeave); window.addEventListener("drop", onDrop); window.addEventListener("paste", onPaste);
    return () => { window.removeEventListener("dragenter", onDragEnter); window.removeEventListener("dragover", onDragOver); window.removeEventListener("dragleave", onDragLeave); window.removeEventListener("drop", onDrop); window.removeEventListener("paste", onPaste); };
  }, [submitFiles, enabled]);

  const perform = async (job, stage, action, prompt = "") => {
    const lock = `${job.id}:${stage}:${action}`;
    if (actionLocks.current.has(lock)) return;
    actionLocks.current.add(lock);
    setBusyId(job.id); setError("");
    try {
      if (stage === "garment" && action === "approve") {
        const draft = drafts[job.id];
        const metadata = { ...draft, secondaryColor: draft.secondaryColor || null, tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean) };
        await importJobRequest(`${API}/${job.id}/metadata`, { method: "PATCH", body: JSON.stringify({ metadata }) });
        const updated = await importJobRequest(`${API}/${job.id}/stages/garment/approve`, { method: "POST" });
        const saved = updated.persistedRecord || {};
        const garmentPath = saved.image || `/api/import/library/import-${job.id}-garment.png`;
        onGarmentApproved?.({ id: `import-${job.id}`, ...metadata, image: garmentPath, thumbnail: saved.thumbnail || garmentPath, modeledImage: saved.modeledImage || null, palette: [metadata.color, metadata.secondaryColor].filter(Boolean), importJobId: job.id });
        setJobs((current) => current.map((item) => item.id === job.id ? updated : item));
      } else {
        const updated = await importJobRequest(`${API}/${job.id}/stages/${stage}/${action}`, { method: "POST", body: action === "regenerate" ? JSON.stringify({ prompt }) : undefined });
        const removeFromQueue = action === "reject" || (stage === "modeled" && action === "approve");
        const remainingJobs = removeFromQueue ? jobs.filter((item) => item.id !== job.id) : null;
        setJobs((current) => removeFromQueue ? current.filter((item) => item.id !== job.id) : current.map((item) => item.id === job.id ? updated : item));
        if (removeFromQueue) {
          setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== job.id)));
          setSelectedReviewId(null);
          if (!remainingJobs.length) setOpen(false);
        }
        if (action === "regenerate") setRegenerationPrompts((current) => ({ ...current, [`${job.id}:${stage}`]: "" }));
        if (stage === "modeled" && action === "approve") onModeledApproved?.(job.id, updated.persistedRecord?.modeledImage || `/api/import/library/import-${job.id}-modeled.png`);
      }
    } catch (requestError) { setError(requestError.message); }
    finally { actionLocks.current.delete(lock); setBusyId(null); }
  };

  const performCleanup = async (job, action, requestedTolerance) => {
    setBusyId(job.id); setError("");
    try {
      const tolerance = requestedTolerance ?? cleanupTolerances[job.id] ?? job.stages?.garment?.cleanupTolerance ?? 46;
      const updated = await importJobRequest(`${API}/${job.id}/stages/garment/cleanup-${action}`, { method: "POST", body: JSON.stringify({ tolerance }) });
      setJobs((current) => current.map((item) => item.id === job.id ? updated : item));
      setCleanupTolerances((current) => ({ ...current, [job.id]: updated.stages?.garment?.cleanupTolerance ?? tolerance }));
      setSelectedReviewId(job.id);
    } catch (requestError) { setError(requestError.message); }
    finally { setBusyId(null); }
  };

  const deleteJob = async (job) => {
    setBusyId(job.id); setError("");
    try {
      await importJobRequest(`${API}/${job.id}`, { method: "DELETE" });
      const remaining = jobs.filter((item) => item.id !== job.id);
      setJobs(remaining);
      setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== job.id)));
      if (selectedReviewId === job.id) setSelectedReviewId(null);
      if (!remaining.length) setOpen(false);
    } catch (requestError) { setError(requestError.message); }
    finally { setBusyId(null); }
  };

  const active = jobs[jobs.length - 1];
  const setupRequired = setup?.ready === false;
  const activeStatus = preparing ? { tone: "processing", text: "正在准备上传图片" } : setupRequired ? { tone: "error", text: "需要完成设置" } : error ? { tone: "error", text: "上传失败", detail: error } : active ? deriveStatus(active) : notice;
  const readyCount = jobs.filter((job) => deriveStatus(job).tone === "ready").length;
  const selectedReviewJob = jobs.find((job) => job.id === selectedReviewId && (reviewStageForJob(job) || hasCleanupFailure(job)));
  const reviewJob = selectedReviewJob || jobs.find((job) => reviewStageForJob(job)) || jobs.find((job) => hasCleanupFailure(job)) || active;
  const reviewStage = reviewJob ? reviewStageForJob(reviewJob) : null;
  const progress = 0;
  const hasImportActivity = Boolean(preparing || jobs.length || notice || error || setupRequired);
  const missingProviderConfig = setup?.missingConfiguration?.join(", ") || "所选模型供应商的凭据";

  return (
    <>
      <input ref={inputRef} type="file" accept="image/*" multiple hidden onChange={(event) => { const files = Array.from(event.currentTarget.files || []); event.currentTarget.value = ""; void submitFiles(files); }} />
      <div className="import-drop-overlay" data-active={dragging && !setupRequired} aria-hidden={!dragging || setupRequired}><div className="import-drop-target is-over"><UploadSimple size={34} weight="light" /><h2>拖入衣物图片</h2><p>可以使用单件衣物照片，也可以使用完整穿搭照片；现有衣橱内容不会被覆盖。</p></div></div>
      <aside className={`import-tray${hasImportActivity ? " is-expanded" : ""}`} aria-label="衣橱导入">
        <button className="import-tray__button" type="button" onClick={() => setupRequired || hasImportActivity ? setOpen(true) : inputRef.current?.click()} aria-label={setupRequired ? "打开设置说明" : hasImportActivity ? "打开导入进度" : "添加衣物"}>{activeStatus?.tone === "processing" ? <SpinnerGap size={19} className="import-spinner" /> : activeStatus?.tone === "error" ? <WarningCircle size={19} /> : readyCount ? <span>{readyCount}</span> : notice ? <X size={18} /> : <Plus size={19} />}</button>
        <div className="import-tray__actions">{active && <img className="import-tray__preview" src={active.stages?.garment?.assetUrl || active.stages?.garment?.failedAssetUrl || active.stages?.crop?.assetUrl || active.originalAssetUrl} alt="" />}<span className="import-tray__label">{activeStatus?.text || "添加衣物"}</span>{!setupRequired && <button className="import-icon-button" type="button" onClick={() => inputRef.current?.click()} aria-label="选择图片"><UploadSimple size={17} /></button>}</div>
      </aside>
      <div className="import-popover-backdrop" data-open={open} onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
        <section className="import-popover" role="dialog" aria-modal="true" aria-labelledby="import-title">
          <header className="import-popover__header"><div><p className="import-popover__eyebrow">衣橱导入</p><h2 className="import-popover__title" id="import-title">{readyCount ? `${readyCount} 项等待审核` : activeStatus?.tone === "error" ? "导入需要处理" : jobs.length ? "正在准备新单品" : notice?.text || "添加到衣橱"}</h2></div><button className="import-icon-button" type="button" onClick={() => setOpen(false)} aria-label="关闭导入进度"><X size={20} /></button></header>
          {!jobs.length ? preparing ? <div className="import-drop-target"><SpinnerGap size={30} className="import-spinner" /><h2>正在上传图片</h2><p>正在将手机照片直接上传到你的 本机，然后创建 AI 导入任务。</p></div> : setupRequired ? <div className="import-drop-target import-setup-warning"><WarningCircle size={30} /><h2>需要完成设置</h2><p>请在 <code>.env</code> 中配置 <code>{missingProviderConfig}</code>，然后重新启动应用。人物参考照片仅在真人展示和搭配生成时需要，可在本地设置上传。</p></div> : <div className="import-drop-target"><UploadSimple size={28} /><h2>{notice ? "尝试另一张图片" : "选择或粘贴图片"}</h2><p>{notice?.detail || "程序会分离每件衣物、建议基本信息，并在写入衣橱前等待你的审核。"}</p><button className="import-button import-button--primary" onClick={() => { setNotice(null); inputRef.current?.click(); }}>选择图片</button></div> : (
            <>
              <div className={`import-progress${activeStatus?.tone !== "processing" ? " is-reviewing" : progress < 100 ? " is-indeterminate" : ""}`}><div className="import-progress__meta"><span>{activeStatus?.text}</span><span>{jobs.length} 件</span></div>{activeStatus?.tone === "processing" && <div className="import-progress__track"><div className="import-progress__bar" style={{ "--import-progress": `${progress}%` }} /></div>}</div>
              {reviewJob && reviewStage ? <ReviewEditor job={reviewJob} stage={reviewStage} draft={drafts[reviewJob.id] || defaultDraft(reviewJob)} setDraft={(draft) => setDrafts((current) => ({ ...current, [reviewJob.id]: draft }))} regenPrompt={regenerationPrompts[`${reviewJob.id}:${reviewStage}`] || ""} setRegenPrompt={(prompt) => setRegenerationPrompts((current) => ({ ...current, [`${reviewJob.id}:${reviewStage}`]: prompt }))} busy={busyId === reviewJob.id} onAction={(action, prompt) => perform(reviewJob, reviewStage, action, prompt)} /> : reviewJob && hasCleanupFailure(reviewJob) ? <CleanupEditor job={reviewJob} tolerance={cleanupTolerances[reviewJob.id] ?? reviewJob.stages.garment.cleanupTolerance ?? 46} setTolerance={(tolerance) => setCleanupTolerances((current) => ({ ...current, [reviewJob.id]: tolerance }))} busy={busyId === reviewJob.id} onPreview={(tolerance) => performCleanup(reviewJob, "preview", tolerance)} onAccept={() => performCleanup(reviewJob, "accept")} /> : null}
              <div className="import-card-list">{jobs.map((job) => { const status = deriveStatus(job); const itemName = drafts[job.id]?.name || job.metadata?.name || "新单品"; const failedStage = job.stages?.garment?.status === "failed" ? "garment" : job.stages?.modeled?.status === "failed" ? "modeled" : null; return <article className={`import-card is-${status.tone}${reviewJob?.id === job.id ? " is-selected" : ""}`} key={job.id}><img className="import-card__image" src={job.stages?.garment?.assetUrl || job.stages?.garment?.failedAssetUrl || job.stages?.crop?.assetUrl || job.originalAssetUrl} alt="" /><div className="import-card__body"><h3 className="import-card__title">{itemName}</h3><p className="import-card__detail import-card__detail--status" data-tone={status.tone}>{status.tone === "error" ? status.detail : status.text}</p></div><div className="import-card__actions">{status.tone === "ready" && <button className="import-icon-button" onClick={() => { setSelectedReviewId(job.id); setOpen(true); }} aria-label={`审核${itemName}`}><Check size={17} /></button>}{failedStage && <button className="import-button import-card__retry" disabled={busyId === job.id} onClick={() => perform(job, failedStage, "regenerate", "")}><ArrowCounterClockwise size={14} /> 重试</button>}<button className="import-icon-button import-card__delete" disabled={busyId === job.id} onClick={() => deleteJob(job)} aria-label={`从导入队列删除${itemName}`}><Trash size={16} /></button></div></article>; })}</div>
              <div className="import-actions"><button className="import-button" onClick={() => inputRef.current?.click()}><Plus size={14} /> 继续添加</button></div>
            </>
          )}
          {error && <p className="import-status is-error" role="alert">{error}</p>}
        </section>
      </div>
    </>
  );
}

export function WardrobeImportFlow({ onGarmentApproved, onModeledApproved }) {
  const [mode, setMode] = useState("manual");
  return <>
    <div className="import-mode-switch" role="group" aria-label="添加方式">
      <button type="button" className="secondary-button" aria-pressed={mode === "manual"} onClick={() => setMode("manual")}>手动添加</button>
      <button type="button" className="secondary-button" aria-pressed={mode === "ai"} onClick={() => setMode("ai")}>AI 导入</button>
    </div>
    <div hidden={mode !== "ai"}><AiWardrobeImportFlow enabled={mode === "ai"} onGarmentApproved={onGarmentApproved} onModeledApproved={onModeledApproved} /></div>
    <div hidden={mode !== "manual"}><ManualWardrobeImportFlow enabled={mode === "manual"} onGarmentApproved={onGarmentApproved} /></div>
  </>;
}
