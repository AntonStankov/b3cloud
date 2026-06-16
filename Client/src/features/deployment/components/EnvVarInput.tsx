import { useMemo, useState } from "react";
import type { EnvVarPair } from "../types";

interface EnvVarInputProps {
  values: EnvVarPair[];
  onChange: (values: EnvVarPair[]) => void;
}

export function EnvVarInput({ values, onChange }: EnvVarInputProps) {
  const [bulkOpen, setBulkOpen] = useState(false);
  const bulkValue = useMemo(() => values.map((item) => `${item.key}=${item.value}`).join("\n"), [values]);

  function update(id: string, patch: Partial<EnvVarPair>) {
    onChange(values.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  function addRow() {
    onChange([...values, { id: crypto.randomUUID(), key: "", value: "", secret: true }]);
  }

  function removeRow(id: string) {
    onChange(values.filter((item) => item.id !== id));
  }

  function importBulk(raw: string) {
    const imported = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [key, ...rest] = line.split("=");
        return { id: crypto.randomUUID(), key: key.trim(), value: rest.join("=").trim(), secret: true };
      })
      .filter((item) => item.key);
    onChange(imported);
  }

  return (
    <div className="rounded-[24px] border border-white/5 bg-white/[0.025] p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.22em] text-cyan-200/60">Environment</p>
          <h3 className="mt-1 text-lg font-semibold tracking-[-0.03em] text-white">Runtime variables</h3>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => setBulkOpen((value) => !value)} className="rounded-xl border border-white/5 bg-white/[0.04] px-3 py-2 text-sm text-white/70 transition-all duration-200 hover:text-white">
            Bulk import
          </button>
          <button type="button" onClick={addRow} className="rounded-xl border border-cyan-300/20 bg-cyan-300/10 px-3 py-2 text-sm text-cyan-100 transition-all duration-200 hover:bg-cyan-300/15">
            Add variable
          </button>
        </div>
      </div>
      {bulkOpen && (
        <textarea
          defaultValue={bulkValue}
          onBlur={(event) => importBulk(event.target.value)}
          placeholder="DATABASE_URL=postgres://..."
          className="mb-4 min-h-32 w-full rounded-2xl border border-white/5 bg-[#0B0B0F] p-3 font-mono text-sm text-white/75 outline-none transition-all duration-200 placeholder:text-white/25 focus:border-cyan-300/30"
        />
      )}
      <div className="space-y-2">
        {values.map((item) => (
          <div key={item.id} className="rounded-2xl border border-white/5 bg-[#0B0B0F]/35 p-2">
            <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_auto_auto] gap-2 max-md:grid-cols-1">
              <input value={item.key} onChange={(event) => update(item.id, { key: event.target.value })} placeholder="KEY" className="rounded-xl border border-white/5 bg-white/[0.04] px-3 py-2 font-mono text-sm text-white outline-none placeholder:text-white/25" />
              <input value={item.value} onChange={(event) => update(item.id, { value: event.target.value })} placeholder="value" type={item.secret ? "password" : "text"} className="rounded-xl border border-white/5 bg-white/[0.04] px-3 py-2 font-mono text-sm text-white outline-none placeholder:text-white/25" />
              <button type="button" onClick={() => update(item.id, { secret: !item.secret })} className="rounded-xl border border-white/5 bg-white/[0.04] px-3 py-2 font-mono text-xs text-white/60">
                {item.secret ? "secret" : "plain"}
              </button>
              <button type="button" onClick={() => removeRow(item.id)} className="rounded-xl border border-rose-300/10 bg-rose-400/5 px-3 py-2 font-mono text-xs text-rose-200/80">
                remove
              </button>
            </div>
            {(item.source || item.evidence?.[0]) && (
              <p className="mt-2 px-1 text-xs leading-5 text-white/35">
                {item.source && <span className="font-mono text-cyan-100/55">{item.source}</span>}
                {item.source && item.evidence?.[0] ? " · " : ""}
                {item.evidence?.[0]}
              </p>
            )}
          </div>
        ))}
        {!values.length && <div className="rounded-2xl border border-dashed border-white/10 p-4 text-sm text-white/40">No variables required yet.</div>}
      </div>
    </div>
  );
}
