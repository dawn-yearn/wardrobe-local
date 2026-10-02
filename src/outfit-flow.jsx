import { useEffect, useMemo, useState } from "react";
import {
  ArrowCounterClockwise,
  Check,
  Plus,
  SpinnerGap,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react";
import { OptimizedImage } from "./OptimizedImage.jsx";
import { apiFetch } from "./api.js";
import "./outfit-flow.css";

const OUTFIT_API = "/api/outfits";

async function api(path, options) {
  const response = await apiFetch(path, {
    cache: "no-store",
    headers: options?.body ? { "Content-Type": "application/json" } : undefined,
    ...options,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.detail || result.error || "请求失败");
    error.status = response.status;
    throw error;
  }
  return result;
}

function ChoiceCard({ item, selected, disabled, onSelect }) {
  return (
    <button
      className={`outfit-choice${selected ? " is-selected" : ""}`}
      type="button"
      disabled={disabled}
      onClick={() => onSelect(item.id)}
      aria-pressed={selected}
    >
      <OptimizedImage
        src={item.thumbnail || item.image}
        alt=""
        sizes="(max-width: 620px) 42vw, 180px"
        breakpoints={[120, 180, 240, 320]}
      />
      <span>{item.name || "未命名单品"}</span>
      {selected && <Check size={17} weight="bold" aria-hidden="true" />}
    </button>
  );
}

function SelectionSlot({ label, item, onClear, locked }) {
  return (
    <article className={`outfit-slot${item ? " is-filled" : ""}`}>
      <p>{label}</p>
      {item ? (
        <>
          <OptimizedImage
            src={item.thumbnail || item.image}
            alt=""
            sizes="140px"
            breakpoints={[120, 180, 240]}
          />
          <strong>{item.name || "未命名单品"}</strong>
          {!locked && <button type="button" onClick={onClear}>移除</button>}
        </>
      ) : (
        <div className="outfit-slot__empty"><Plus size={24} /><span>请选择一件</span></div>
      )}
    </article>
  );
}

function GarmentSummary({ garments = [] }) {
  return (
    <div className="outfit-garment-summary">
      {garments.map((garment) => (
        <article key={`${garment.role}:${garment.itemId}`}>
          <OptimizedImage
            src={garment.image}
            alt=""
            sizes="90px"
            breakpoints={[90, 140, 180]}
          />
          <div>
            <small>{garment.role === "top" ? "上衣" : "下装"}</small>
            <strong>{garment.name}</strong>
          </div>
        </article>
      ))}
    </div>
  );
}

function JobPanel({ job, onAccept, onRegenerate, onDelete, busy }) {
  const [prompt, setPrompt] = useState("");
  const processing = ["queued", "processing"].includes(job.status);
  const review = job.status === "review";
  const failed = job.status === "failed";

  return (
    <section className="outfit-job" aria-live="polite">
      <div className="outfit-job__visual">
        {review && job.previewUrl ? (
          <OptimizedImage
            key={job.previewUrl}
            src={job.previewUrl}
            alt="待审核的穿搭预览"
            sizes="(max-width: 900px) 100vw, 620px"
            breakpoints={[480, 720, 960, 1280]}
            priority
          />
        ) : processing ? (
          <div className="outfit-job__placeholder">
            <SpinnerGap size={38} className="outfit-spinner" />
            <strong>正在生成穿搭预览</strong>
            <span>人物参考图、上衣和下装正在交给图片模型处理。</span>
          </div>
        ) : (
          <div className="outfit-job__placeholder is-error">
            <WarningCircle size={38} />
            <strong>生成没有完成</strong>
            <span>{job.error || "请重新生成或删除这个任务。"}</span>
          </div>
        )}
      </div>

      <aside className="outfit-job__details">
        <div>
          <p className="outfit-eyebrow">{review ? "等待审核" : failed ? "需要处理" : "生成中"}</p>
          <h2>{review ? "这套搭配可以保存吗？" : failed ? "重新尝试这套搭配" : "正在准备完整造型"}</h2>
        </div>
        <GarmentSummary garments={job.garments} />

        {(review || failed) && (
          <label className="outfit-prompt">
            <span>重新生成要求（可选）</span>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              maxLength={1200}
              placeholder="例如：保持衣物不变，换成更自然的站姿"
            />
          </label>
        )}

        <div className="outfit-job__actions">
          {review && (
            <button className="outfit-button is-primary" type="button" disabled={busy} onClick={onAccept}>
              <Check size={17} weight="bold" /> 接受并保存
            </button>
          )}
          {(review || failed) && (
            <button className="outfit-button" type="button" disabled={busy} onClick={() => onRegenerate(prompt)}>
              <ArrowCounterClockwise size={17} /> 重新生成
            </button>
          )}
          {(review || failed) && (
            <button className="outfit-button is-danger" type="button" disabled={busy} onClick={onDelete}>
              <Trash size={17} /> 删除
            </button>
          )}
        </div>
      </aside>
    </section>
  );
}

export function OutfitBuilder({ items, onSaved }) {
  const [topId, setTopId] = useState(null);
  const [bottomId, setBottomId] = useState(null);
  const [job, setJob] = useState(null);
  const [configuration, setConfiguration] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const tops = useMemo(() => items.filter((item) => item.part === "upperbody"), [items]);
  const bottoms = useMemo(() => items.filter((item) => item.part === "lowerbody"), [items]);
  const top = items.find((item) => item.id === topId) || null;
  const bottom = items.find((item) => item.id === bottomId) || null;
  const locked = Boolean(job);

  useEffect(() => {
    let active = true;
    Promise.all([
      api(`${OUTFIT_API}/config`),
      api(`${OUTFIT_API}/jobs`),
    ]).then(([config, jobs]) => {
      if (!active) return;
      setConfiguration(config);
      const current = jobs.at(-1) || null;
      setJob(current);
      if (current) {
        setTopId(current.selection.topId);
        setBottomId(current.selection.bottomId);
      }
    }).catch((requestError) => {
      if (active) setError(requestError.message);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!job || !["queued", "processing"].includes(job.status)) return undefined;
    let active = true;
    const refresh = async () => {
      try {
        const next = await api(`${OUTFIT_API}/jobs/${job.id}`);
        if (active) setJob(next);
      } catch (requestError) {
        if (!active) return;
        if (requestError.status === 404) {
          setJob(null);
          setError("本地任务已失效，请重新生成这套搭配。");
        } else {
          setError(requestError.message);
        }
      }
    };
    const timer = setInterval(refresh, 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [job?.id, job?.status]);

  const create = async () => {
    if (!topId || !bottomId || busy) return;
    setBusy(true);
    setError("");
    try {
      const created = await api(`${OUTFIT_API}/jobs`, {
        method: "POST",
        body: JSON.stringify({ topId, bottomId }),
      });
      setJob(created);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  const accept = async () => {
    setBusy(true);
    setError("");
    try {
      const outfit = await api(`${OUTFIT_API}/jobs/${job.id}/accept`, { method: "POST" });
      setJob(null);
      onSaved(outfit);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  const regenerate = async (prompt) => {
    setBusy(true);
    setError("");
    try {
      const next = await api(`${OUTFIT_API}/jobs/${job.id}/regenerate`, {
        method: "POST",
        body: JSON.stringify({ prompt }),
      });
      setJob(next);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError("");
    try {
      await api(`${OUTFIT_API}/jobs/${job.id}`, { method: "DELETE" });
      setJob(null);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <main className="outfit-page"><p className="outfit-status">正在加载搭配工具…</p></main>;

  return (
    <main className="outfit-page">
      <header className="outfit-page__header">
        <div>
          <p className="outfit-eyebrow">创建搭配</p>
          <h1>选择一件上衣和一件下装</h1>
          <p>生成时只会向模型发送人物参考图和这两件衣物的本地单品图。</p>
        </div>
      </header>

      {error && <p className="outfit-alert is-error">{error}</p>}
      {configuration?.ready === false && (
        <p className="outfit-alert is-error">
          {configuration.missingConfiguration?.length > 0 && <>请在 <code>.env</code> 中配置 {configuration.missingConfiguration.join("、")} 并重启服务。 </>}
          {!configuration.hasModelReference && <>请在「本地设置」上传人物参考照片。 </>}
          已生成的预览仍可查看、保存或删除。
        </p>
      )}

      {job ? (
        <JobPanel
          job={job}
          busy={busy}
          onAccept={accept}
          onRegenerate={regenerate}
          onDelete={remove}
        />
      ) : (
        <>
          <section className="outfit-selection">
            <SelectionSlot label="上衣" item={top} locked={locked} onClear={() => setTopId(null)} />
            <SelectionSlot label="下装" item={bottom} locked={locked} onClear={() => setBottomId(null)} />
          </section>

          <section className="outfit-picker">
            <div className="outfit-picker__heading">
              <div><p className="outfit-eyebrow">第一步</p><h2>选择上衣</h2></div>
              <span>{tops.length} 件可选</span>
            </div>
            {tops.length ? (
              <div className="outfit-choice-grid">
                {tops.map((item) => (
                  <ChoiceCard
                    key={item.id}
                    item={item}
                    selected={item.id === topId}
                    disabled={locked}
                    onSelect={(id) => setTopId((current) => current === id ? null : id)}
                  />
                ))}
              </div>
            ) : <p className="outfit-empty">衣橱里还没有上衣。</p>}
          </section>

          <section className="outfit-picker">
            <div className="outfit-picker__heading">
              <div><p className="outfit-eyebrow">第二步</p><h2>选择下装</h2></div>
              <span>{bottoms.length} 件可选</span>
            </div>
            {bottoms.length ? (
              <div className="outfit-choice-grid">
                {bottoms.map((item) => (
                  <ChoiceCard
                    key={item.id}
                    item={item}
                    selected={item.id === bottomId}
                    disabled={locked}
                    onSelect={(id) => setBottomId((current) => current === id ? null : id)}
                  />
                ))}
              </div>
            ) : <p className="outfit-empty">衣橱里还没有下装。</p>}
          </section>

          <div className="outfit-generate-bar">
            <div>
              <strong>{top && bottom ? "已经可以生成" : "请先选齐上衣和下装"}</strong>
              <span>本版本固定使用人物、上衣、下装三张输入图。</span>
            </div>
            <button
              className="outfit-button is-primary"
              type="button"
              disabled={!top || !bottom || busy || configuration?.ready === false}
              onClick={create}
            >
              {busy ? <SpinnerGap size={18} className="outfit-spinner" /> : null}
              生成穿搭预览
            </button>
          </div>
        </>
      )}
    </main>
  );
}

export function MyOutfits({ onCreate, canCreate = true }) {
  const [outfits, setOutfits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    api(OUTFIT_API)
      .then((records) => {
        if (active) setOutfits(records);
      })
      .catch((requestError) => {
        if (active) setError(requestError.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="outfit-page">
      <header className="outfit-page__header is-row">
        <div>
          <p className="outfit-eyebrow">我的搭配</p>
          <h1>已保存的完整造型</h1>
          <p>每张效果图都保留了生成时使用的上衣和下装记录。</p>
        </div>
        {canCreate && <button className="outfit-button is-primary" type="button" onClick={onCreate}>
          <Plus size={17} /> 创建搭配
        </button>}
      </header>

      {error && <p className="outfit-alert is-error">{error}</p>}
      {loading && <p className="outfit-status">正在加载我的搭配…</p>}
      {!loading && !error && !outfits.length && (
        <div className="outfit-empty-state">
          <h2>还没有保存过搭配</h2>
          <p>{canCreate ? "选择一件上衣和一件下装，生成第一张完整穿搭预览。" : "解锁 AI Beta 后即可创建新的 AI 搭配。"}</p>
          {canCreate && <button className="outfit-button is-primary" type="button" onClick={onCreate}>开始创建</button>}
        </div>
      )}
      {!!outfits.length && (
        <section className="saved-outfit-grid">
          {[...outfits].reverse().map((outfit) => (
            <article className="saved-outfit" key={outfit.id}>
              <OptimizedImage
                className="saved-outfit__image"
                src={outfit.image}
                alt={outfit.name}
                sizes="(max-width: 700px) 100vw, 50vw"
                breakpoints={[480, 720, 960]}
              />
              <div className="saved-outfit__body">
                <div>
                  <h2>{outfit.name}</h2>
                  <time dateTime={outfit.createdAt}>
                    {new Date(outfit.createdAt).toLocaleString("zh-CN")}
                  </time>
                </div>
                <GarmentSummary garments={outfit.garments} />
              </div>
            </article>
          ))}
        </section>
      )}
    </main>
  );
}
