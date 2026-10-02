import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Plus, Trash, X } from "@phosphor-icons/react";
import { WardrobeImportFlow } from "./import-flow.jsx";
import { OptimizedImage } from "./OptimizedImage.jsx";
import { MyOutfits, OutfitBuilder } from "./outfit-flow.jsx";
import { apiFetch } from "./api.js";
import { uploadLocalImage, uploadPayload } from "./storage-upload.js";

const TYPES = [
  { id: "all", label: "全部" },
  { id: "upperbody", label: "上衣", singular: "上衣" },
  { id: "wholebody_up", label: "外套", singular: "外套" },
  { id: "lowerbody", label: "下装", singular: "下装" },
  { id: "accessories_up", label: "配饰", singular: "配饰" },
  { id: "shoes", label: "鞋履", singular: "鞋履" },
];

const TYPE_MAP = Object.fromEntries(TYPES.map((type) => [type.id, type]));
const TYPE_ORDER = Object.fromEntries(TYPES.slice(1).map((type, index) => [type.id, index]));


function rgbToHex(red, green, blue) {
  return `#${[red, green, blue].map((value) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0")).join("")}`;
}

function colorDistance(first, second) {
  return Math.sqrt(
    ((first.red - second.red) ** 2)
    + ((first.green - second.green) ** 2)
    + ((first.blue - second.blue) ** 2),
  );
}

function extractPalette(image) {
  const canvas = document.createElement("canvas");
  canvas.width = 72;
  canvas.height = 72;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const buckets = new Map();

  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3];
    if (alpha < 72) continue;

    const red = pixels[index];
    const green = pixels[index + 1];
    const blue = pixels[index + 2];
    const key = `${Math.round(red / 28)}-${Math.round(green / 28)}-${Math.round(blue / 28)}`;
    const current = buckets.get(key) || { red: 0, green: 0, blue: 0, count: 0 };
    current.red += red;
    current.green += green;
    current.blue += blue;
    current.count += 1;
    buckets.set(key, current);
  }

  const ranked = [...buckets.values()]
    .map((bucket) => ({
      red: Math.round(bucket.red / bucket.count),
      green: Math.round(bucket.green / bucket.count),
      blue: Math.round(bucket.blue / bucket.count),
      count: bucket.count,
    }))
    .sort((a, b) => b.count - a.count);

  const selected = [];
  for (const color of ranked) {
    if (selected.every((existing) => colorDistance(existing, color) > 38)) selected.push(color);
    if (selected.length === 5) break;
  }

  return selected.map((color) => rgbToHex(color.red, color.green, color.blue));
}

function buildSamplingCanvas(image) {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext("2d", { willReadFrequently: true }).drawImage(image, 0, 0);
  return canvas;
}

function sampleImageColor(image, canvas, event) {
  const bounds = image.getBoundingClientRect();
  const scale = Math.min(bounds.width / image.naturalWidth, bounds.height / image.naturalHeight);
  const renderedWidth = image.naturalWidth * scale;
  const renderedHeight = image.naturalHeight * scale;
  const offsetX = (bounds.width - renderedWidth) / 2;
  const offsetY = (bounds.height - renderedHeight) / 2;
  const imageX = Math.floor((event.clientX - bounds.left - offsetX) / scale);
  const imageY = Math.floor((event.clientY - bounds.top - offsetY) / scale);

  if (imageX < 0 || imageY < 0 || imageX >= canvas.width || imageY >= canvas.height) return null;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  for (let radius = 0; radius <= 18; radius += 2) {
    const startX = Math.max(0, imageX - radius);
    const startY = Math.max(0, imageY - radius);
    const width = Math.min(canvas.width - startX, (radius * 2) + 1);
    const height = Math.min(canvas.height - startY, (radius * 2) + 1);
    const data = context.getImageData(startX, startY, width, height).data;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3] > 96) return rgbToHex(data[index], data[index + 1], data[index + 2]);
    }
  }

  return null;
}

function GalleryItem({ item, selected, onOpen }) {
  const type = TYPE_MAP[item.part]?.singular || "衣橱单品";

  return (
    <button
      className={`gallery-item${selected ? " selected" : ""}`}
      type="button"
      onClick={() => onOpen(item.id)}
      aria-label={`查看${item.name || type}`}
      aria-pressed={selected}
      data-testid={`wardrobe-item-${item.id}`}
    >
      <OptimizedImage
        src={item.thumbnail || item.image}
        alt=""
        sizes="(max-width: 520px) calc(50vw - 16px), (max-width: 860px) calc(33vw - 18px), 180px"
        breakpoints={[120, 180, 240, 320, 480]}
      />
    </button>
  );
}

function TagEditor({ tags, onChange }) {
  const [input, setInput] = useState("");

  const addTag = () => {
    const nextTag = input.trim().replace(/^#/, "");
    if (!nextTag || tags.some((tag) => tag.toLowerCase() === nextTag.toLowerCase())) return;
    onChange([...tags, nextTag]);
    setInput("");
  };

  return (
    <div className="tag-editor">
      <div className="editable-tags">
        {tags.map((tag) => (
          <span className="editable-tag" key={tag}>
            {tag}
            <button type="button" onClick={() => onChange(tags.filter((existing) => existing !== tag))} aria-label={`移除${tag}`}>
              <X size={12} weight="regular" aria-hidden="true" />
            </button>
          </span>
        ))}
      </div>
      <div className="tag-input-row">
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              addTag();
            }
          }}
          placeholder="添加细节标签"
          aria-label="添加细节标签"
        />
        <button type="button" onClick={addTag} disabled={!input.trim()} aria-label="添加细节">
          <Plus size={15} weight="regular" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function ColorControl({ label, field, value, palette, onChange, sampling, setSampling, optional = false, onClear, onAdd }) {
  if (optional && !value) {
    return (
      <div className="color-slot empty-color-slot">
        <div className="color-slot-heading">
          <span>{label}</span>
          <small>可选</small>
        </div>
        <p>没有检测到明显的辅助色。</p>
        <button className="add-secondary-button" type="button" onClick={onAdd}>添加辅助色</button>
      </div>
    );
  }

  return (
    <div className="color-slot">
      <div className="color-slot-heading">
        <span>{label}</span>
        {optional && <button type="button" onClick={onClear}>移除</button>}
      </div>
      <label className="selected-color-control">
        <input
          type="color"
          value={value || "#9a9286"}
          onChange={(event) => onChange(event.target.value)}
          aria-label={`选择${label}`}
        />
        <span className="selected-color-copy">
          <small>当前选择</small>
          <strong>{value || "自定义"}</strong>
        </span>
      </label>
      <div className="suggestion-heading">
        <span>图片取色建议</span>
        <small>点击即可应用</small>
      </div>
      <div className="palette" aria-label={`${label}图片取色建议`}>
        {palette.map((color) => (
          <button
            type="button"
            key={color}
            className={value?.toLowerCase() === color.toLowerCase() ? "active" : ""}
            style={{ backgroundColor: color }}
            onClick={() => onChange(color)}
            aria-label={`将${color}设为${label}`}
            title={color}
          />
        ))}
      </div>
      <button
        className={`sample-button${sampling === field ? " active" : ""}`}
        type="button"
        onClick={() => setSampling((current) => current === field ? null : field)}
      >
        {sampling === field ? "取消取色" : `从图片选取${label}`}
      </button>
    </div>
  );
}

function ItemEditor({ draft, setDraft, palette, sampling, setSampling, sampleStatus }) {
  const suggestedSecondary = palette.find((color) => color.toLowerCase() !== draft.color?.toLowerCase()) || "#9a9286";

  return (
    <div className="item-editor">
      <label className="field">
        <span>名称</span>
        <input
          value={draft.name}
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          placeholder="未命名单品"
        />
      </label>

      <label className="field">
        <span>分类</span>
        <select value={draft.part || ""} onChange={(event) => setDraft((current) => ({ ...current, part: event.target.value || null }))}>
          <option value="">未分类</option>
          {TYPES.slice(1).map((type) => <option value={type.id} key={type.id}>{type.label}</option>)}
        </select>
      </label>

      <fieldset className="color-field">
        <legend>颜色</legend>
        <div className="colors-editor">
          <ColorControl
            label="主色"
            field="primary"
            value={draft.color}
            palette={palette}
            onChange={(color) => setDraft((current) => ({ ...current, color }))}
            sampling={sampling}
            setSampling={setSampling}
          />
          <ColorControl
            label="辅助色"
            field="secondary"
            value={draft.secondaryColor}
            palette={palette}
            onChange={(secondaryColor) => setDraft((current) => ({ ...current, secondaryColor }))}
            sampling={sampling}
            setSampling={setSampling}
            optional
            onClear={() => setDraft((current) => ({ ...current, secondaryColor: null }))}
            onAdd={() => setDraft((current) => ({ ...current, secondaryColor: suggestedSecondary }))}
          />
        </div>
        <p className="color-help" aria-live="polite">{sampling ? `请点击衣物上的位置选取${sampling === "primary" ? "主色" : "辅助色"}。` : sampleStatus || "主色来自图片；只有在辅助色覆盖明显时才会提供建议。"}</p>
      </fieldset>

      <div className="field details-field">
        <span>细节标签</span>
        <TagEditor tags={draft.tags} onChange={(tags) => setDraft((current) => ({ ...current, tags }))} />
      </div>
    </div>
  );
}

function ItemViewer({ item, onClose, onSave, onDelete }) {
  const closeButtonRef = useRef(null);
  const imageRef = useRef(null);
  const samplingCanvasRef = useRef(null);
  const shakeTimerRef = useRef(null);
  const [sampling, setSampling] = useState(null);
  const [sampleStatus, setSampleStatus] = useState("");
  const [palette, setPalette] = useState(item.palette || []);
  const [draft, setDraft] = useState({ name: item.name || "", part: item.part || "", color: item.color || "", secondaryColor: item.secondaryColor || null, tags: [...(item.tags || [])] });
  const [shaking, setShaking] = useState(false);
  const [closeBlocked, setCloseBlocked] = useState(false);
  const [saving, setSaving] = useState(false);
  const type = TYPE_MAP[item.part]?.singular || "未分类";
  const hasModeledImage = Boolean(item.modeledImage);
  const pieceRotation = useMemo(() => {
    const hash = [...item.id].reduce((total, character) => total + character.charCodeAt(0), 0);
    return `${(hash % 9) - 4}deg`;
  }, [item.id]);

  const isDirty = useMemo(() => {
    const normalizedTags = (tags) => tags.map((tag) => tag.trim()).filter(Boolean);
    return JSON.stringify({
      name: draft.name.trim(),
      part: draft.part || null,
      color: draft.color?.toLowerCase() || null,
      secondaryColor: draft.secondaryColor?.toLowerCase() || null,
      tags: normalizedTags(draft.tags),
    }) !== JSON.stringify({
      name: (item.name || "").trim(),
      part: item.part || null,
      color: item.color?.toLowerCase() || null,
      secondaryColor: item.secondaryColor?.toLowerCase() || null,
      tags: normalizedTags(item.tags || []),
    });
  }, [draft, item]);

  const nudgeUnsaved = useCallback(() => {
    setCloseBlocked(true);
    setShaking(false);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setShaking(true));
    });
    clearTimeout(shakeTimerRef.current);
    shakeTimerRef.current = setTimeout(() => setShaking(false), 420);
  }, []);

  const requestClose = useCallback(() => {
    if (isDirty) nudgeUnsaved();
    else onClose();
  }, [isDirty, nudgeUnsaved, onClose]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        if (sampling) setSampling(null);
        else requestClose();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    document.body.classList.add("viewer-open");
    closeButtonRef.current?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.classList.remove("viewer-open");
      clearTimeout(shakeTimerRef.current);
    };
  }, [requestClose, sampling]);

  useEffect(() => {
    if (!isDirty) setCloseBlocked(false);
  }, [isDirty]);

  useEffect(() => {
    setSampling(null);
    setSampleStatus("");
    setPalette(item.palette || []);
      setDraft({ name: item.name || "", part: item.part || "", color: item.color || "", secondaryColor: item.secondaryColor || null, tags: [...(item.tags || [])] });
  }, [item]);

  const cancelEditing = () => {
    setDraft({ name: item.name || "", part: item.part || "", color: item.color || "", secondaryColor: item.secondaryColor || null, tags: [...(item.tags || [])] });
    setSampling(null);
    setSampleStatus("");
    onClose();
  };

  const saveEditing = async () => {
    setSaving(true);
    try {
      await onSave({ ...item, ...draft, name: draft.name.trim(), tags: draft.tags.map((tag) => tag.trim()).filter(Boolean) });
      setSampling(null);
      setSampleStatus("修改已保存。");
    } catch (error) {
      setSampleStatus(error.message || "无法保存衣物。");
    } finally {
      setSaving(false);
    }
  };

  const handleImageLoad = (event) => {
    samplingCanvasRef.current = buildSamplingCanvas(event.currentTarget);
    const extracted = extractPalette(event.currentTarget);
    setPalette([...new Set([...(item.palette || []), ...extracted])].slice(0, 5));
  };

  const handleImageClick = (event) => {
    if (!sampling || !samplingCanvasRef.current) return;
    const color = sampleImageColor(event.currentTarget, samplingCanvasRef.current, event);
    if (!color) {
      setSampleStatus("该位置是透明区域，请直接点击衣物主体。");
      return;
    }
    const targetField = sampling === "secondary" ? "secondaryColor" : "color";
    setDraft((current) => ({ ...current, [targetField]: color }));
    setPalette((current) => [color, ...current.filter((existing) => existing.toLowerCase() !== color.toLowerCase())].slice(0, 5));
    setSampleStatus(`已将 ${color} 设为${sampling === "primary" ? "主色" : "辅助色"}。`);
    setSampling(null);
  };

  const garmentArtwork = (
    <div
      className={`viewer-art${hasModeledImage ? " viewer-art-floating" : ""}${sampling ? " sampling" : ""}`}
      style={hasModeledImage ? { "--piece-rotation": pieceRotation } : undefined}
    >
      <OptimizedImage
        ref={imageRef}
        src={item.image}
        alt={`已选择的${type}`}
        sizes="(max-width: 520px) 40vw, 300px"
        breakpoints={[160, 240, 320, 480, 640]}
        priority
        onLoad={handleImageLoad}
        onClick={handleImageClick}
      />
      {sampling && <span className="sample-hint">点击衣物进行取色</span>}
    </div>
  );

  return (
    <div className="viewer-overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && requestClose()}>
    <div className="viewer-entry">
    <aside className={`viewer editing${hasModeledImage ? " has-modeled-image" : ""}${shaking ? " shake" : ""}`} role="dialog" aria-modal="true" aria-label="已选择的衣橱单品">
      <button className="viewer-icon-close" type="button" onClick={requestClose} aria-label="关闭单品详情" ref={closeButtonRef}>
        <X size={24} weight="light" aria-hidden="true" />
      </button>

      {hasModeledImage ? (
        <div className="modeled-hero">
          <OptimizedImage
            className="modeled-hero-photo"
            src={item.modeledImage}
            alt={`人物穿着${draft.name || type}的效果图`}
            sizes="(max-width: 860px) 100vw, 520px"
            breakpoints={[320, 480, 640, 800, 1040, 1280]}
            quality={82}
            priority
          />
          <div className="viewer-heading modeled-heading">
            <div>
              <h2>{draft.name || "未命名单品"}</h2>
            </div>
          </div>
          {garmentArtwork}
        </div>
      ) : (
        <>
          <div className="viewer-heading">
            <div>
              <h2>{draft.name || "未命名单品"}</h2>
            </div>
          </div>
          {garmentArtwork}
        </>
      )}

      <div className="viewer-details editing">
        <ItemEditor
          draft={draft}
          setDraft={setDraft}
          palette={palette}
          sampling={sampling}
          setSampling={setSampling}
          sampleStatus={sampleStatus}
        />

        {closeBlocked && <p className="unsaved-notice" role="status">请先保存或取消修改，再关闭窗口。</p>}

        <div className="viewer-actions">
          <button className="delete-button" type="button" disabled={saving} onClick={() => onDelete(item.id)}>
            <Trash size={15} weight="regular" aria-hidden="true" /> 删除
          </button>
          <span className="action-spacer" />
          <button className="secondary-button" type="button" disabled={saving} onClick={cancelEditing}>取消</button>
          <button className="primary-button" type="button" disabled={saving} onClick={saveEditing}>
            <Check size={15} weight="bold" aria-hidden="true" /> 保存
          </button>
        </div>
      </div>
    </aside>
    </div>
    </div>
  );
}

function ProfilePage({ profile, onChange }) {
  const [nickname, setNickname] = useState(profile.nickname);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const update = async (url, options) => {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await apiFetch(url, options);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "保存失败");
      onChange(result); setNotice("已保存到本机");
    } catch (error) { setError(error.message); }
    finally { setBusy(false); }
  };
  const upload = async (event) => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const uploaded = await uploadLocalImage(file, "profile");
      await update("/api/profile/reference", { method: "POST", body: JSON.stringify(uploadPayload(uploaded.uploadId)) });
    } catch (error) { setError(error.message); }
    finally { setBusy(false); }
  };
  return <main className="profile-page">
    <header><p className="eyebrow">本地设置</p><h1>我的 Open Wardrobe</h1></header>
    <section className="profile-card"><h2>基本信息</h2><label className="field"><span>昵称</span><input value={nickname} onChange={event => setNickname(event.target.value)} maxLength={40} /></label><button className="primary-button" disabled={busy || !nickname.trim()} onClick={() => update("/api/profile", { method: "PATCH", body: JSON.stringify({ nickname }) })}>保存昵称</button></section>
    <section className="profile-card"><h2>人物参考照片</h2><p>用于真人试穿和搭配生成。照片保存在本机，生成时发送给所选 AI 服务。</p>{profile.reference_image_url && <img className="profile-reference" src={profile.reference_image_url} alt="当前人物参考照片" />}<label className="primary-button upload-label"><input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={upload} />{profile.reference_image_key ? "更换人物照片" : "上传人物照片"}</label>{profile.reference_image_key && <button className="secondary-button" disabled={busy} onClick={() => update("/api/profile/reference", { method: "DELETE" })}>移除人物照片</button>}</section>
    <section className="profile-card"><h2>AI 服务</h2><p>衣物识别：{profile.ai.visionProvider} · {profile.ai.visionModel}</p><p>图片生成：{profile.ai.imageProvider} · {profile.ai.imageModel}</p><p>搭配模型：{profile.ai.outfitModel}</p><p>{profile.ai.importReady ? "凭证已配置，尚不代表在线调用已验证。" : "AI 凭证未配置，手动添加与已有衣橱仍可使用。"}</p>{profile.ai.missingConfiguration.length > 0 && <p>请在 .env 配置 {profile.ai.missingConfiguration.join("、")}，然后重启本地服务。</p>}<p>AI 需要联网，会使用你自己的服务额度。</p></section>
    <section className="profile-card"><h2>本地数据</h2><p style={{ overflowWrap: "anywhere" }}>{profile.dataDirectory}</p><p>关闭服务后，复制整个数据文件夹即可备份。衣物资料以磁盘文件为准，不依赖浏览器缓存。</p></section>
    {notice && <p className="success-text" role="status">{notice}</p>}{error && <p className="status error" role="alert">{error}</p>}
  </main>;
}

function WardrobeWorkspace({ profile, onProfileChange }) {
  const [items, setItems] = useState([]);
  const [activeType, setActiveType] = useState("all");
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [page, setPage] = useState(() => {
    if (window.location.hash === "#/profile") return "profile";
    if (window.location.hash === "#/outfits/new") return "create-outfit";
    if (window.location.hash === "#/outfits") return "outfits";
    return "wardrobe";
  });

  useEffect(() => {
    const onHashChange = () => {
      if (window.location.hash === "#/outfits/new") setPage("create-outfit");
      else if (window.location.hash === "#/outfits") setPage("outfits");
      else if (window.location.hash === "#/profile") setPage("profile");
      else setPage("wardrobe");
      setSelectedId(null);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    apiFetch("/api/import/wardrobe")
      .then((response) => {
        if (!response.ok) throw new Error("无法加载衣橱。");
        return response.json();
      })
      .then((loadedItems) => {
        setItems(loadedItems);
      })
      .catch((requestError) => setError(requestError.message))
      .finally(() => setLoading(false));
  }, [profile?.user_id]);

  const selectedItem = items.find((item) => item.id === selectedId) || null;

  const visibleItems = useMemo(() => {
    const filtered = activeType === "all" ? items : items.filter((item) => item.part === activeType);
    return [...filtered].sort((a, b) => {
      if (activeType === "all") {
        const typeDifference = (TYPE_ORDER[a.part] ?? 99) - (TYPE_ORDER[b.part] ?? 99);
        if (typeDifference) return typeDifference;
      }
      return a.id.localeCompare(b.id);
    });
  }, [activeType, items]);

  const chooseType = (typeId) => {
    setActiveType(typeId);
    setSelectedId(null);
  };

  const saveItem = async (updatedItem) => {
    const response = await apiFetch(`/api/import/wardrobe/${updatedItem.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        metadata: {
          name: updatedItem.name,
          part: updatedItem.part,
          color: updatedItem.color,
          secondaryColor: updatedItem.secondaryColor,
          tags: updatedItem.tags,
        },
      }),
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.error || "无法保存衣物。");
    setItems((current) => current.map((item) => item.id === updatedItem.id ? value : item));
  };

  const deleteItem = async (id) => {
      try {
        const response = await apiFetch(`/api/import/wardrobe/${id}`, { method: "DELETE" });
        if (!response.ok && response.status !== 404) throw new Error("无法删除导入的单品。");
      } catch (requestError) {
        setError(requestError.message);
        return;
      }
    setItems((current) => current.filter((item) => item.id !== id));
    setSelectedId(null);
  };

  const addImportedItem = useCallback((newItem) => {
    setItems((current) => current.some((item) => item.id === newItem.id) ? current : [...current, newItem]);
  }, []);

  const attachImportedModeledImage = useCallback((jobId, modeledImage) => {
    const id = `import-${jobId}`;
    setItems((current) => current.map((item) => item.id === id ? { ...item, modeledImage } : item));
  }, []);

  const navigate = (nextPage) => {
    const hash = nextPage === "create-outfit"
      ? "#/outfits/new"
      : nextPage === "outfits"
        ? "#/outfits"
        : nextPage === "profile"
          ? "#/profile"
        : "#/wardrobe";
    if (window.location.hash === hash) setPage(nextPage);
    else window.location.hash = hash;
  };

  return (
    <>
    <div className={`app-shell${selectedItem && page === "wardrobe" ? " has-selection" : ""}`}>
      <nav className="app-page-nav" aria-label="主要页面">
        <button className={page === "wardrobe" ? "is-active" : ""} type="button" onClick={() => navigate("wardrobe")}>我的衣橱</button>
        <button className={page === "create-outfit" ? "is-active" : ""} type="button" onClick={() => navigate("create-outfit")}>创建搭配</button>
        <button className={page === "outfits" ? "is-active" : ""} type="button" onClick={() => navigate("outfits")}>我的搭配</button>
        <button className={page === "profile" ? "is-active" : ""} type="button" onClick={() => navigate("profile")}>本地设置</button>
      </nav>

      {page === "wardrobe" && <main className="gallery-pane">
        <header className="gallery-header">
          <div className="gallery-meta-row">
            <p className="piece-count">共 {items.length} 件</p>
          </div>
          <nav className="category-nav" aria-label="按单品分类筛选衣橱">
            {TYPES.map((type) => (
              <button
                key={type.id}
                type="button"
                className={activeType === type.id ? "active" : ""}
                onClick={() => chooseType(type.id)}
                aria-pressed={activeType === type.id}
              >
                {type.label}
              </button>
            ))}
          </nav>
        </header>

        {error && <p className="status error">{error}</p>}
        {!error && loading && <p className="status">正在加载衣橱</p>}
        {!error && !loading && !items.length && <p className="status empty">拖入、粘贴或添加照片，导入你的第一件衣物。</p>}

        {!!items.length && (
          <section className="gallery-grid" aria-label={`${TYPE_MAP[activeType]?.label || "全部"}衣橱单品`}>
            {visibleItems.map((item) => (
              <GalleryItem
                key={item.id}
                item={item}
                selected={selectedId === item.id}
                onOpen={setSelectedId}
              />
            ))}
          </section>
        )}
      </main>}

      {page === "profile" && <ProfilePage profile={profile} onChange={onProfileChange} />}
      {page === "create-outfit" && <OutfitBuilder items={items} onSaved={() => navigate("outfits")} />}
      {page === "outfits" && <MyOutfits canCreate={true} onCreate={() => navigate("create-outfit")} />}
      {selectedItem && page === "wardrobe" && <ItemViewer item={selectedItem} onClose={() => setSelectedId(null)} onSave={saveItem} onDelete={deleteItem} />}
      {page === "wardrobe" && <WardrobeImportFlow onGarmentApproved={addImportedItem} onModeledApproved={attachImportedModeledImage} />}
    </div>
    </>
  );
}

export function App() {
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError("");
    apiFetch("/api/profile").then(async response => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "无法加载本地设置");
      if (active) setProfile(result);
    }).catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [attempt]);
  if (error) return <main className="account-page"><p className="status error">{error}</p><button className="secondary-button" onClick={() => setAttempt(value => value + 1)}>重试</button></main>;
  if (!profile) return <main className="account-page"><p>正在打开本地衣橱…</p></main>;
  return <WardrobeWorkspace profile={profile} onProfileChange={setProfile} />;
}
