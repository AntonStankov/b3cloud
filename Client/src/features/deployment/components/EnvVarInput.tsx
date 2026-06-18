import { useMemo, useRef, useState } from "react";
import type { EnvVarPair } from "../types";

interface EnvVarInputProps {
  values: EnvVarPair[];
  onChange: (values: EnvVarPair[]) => void;
  reservedKeys?: string[];
}

export function EnvVarInput({ values, onChange, reservedKeys = [] }: EnvVarInputProps) {
  const [bulkOpen, setBulkOpen] = useState(false);
  const [ignoredKeys, setIgnoredKeys] = useState<string[]>([]);
  const [importedKeys, setImportedKeys] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bulkValue = useMemo(() => values.map((item) => `${item.key}=${item.value}`).join("\n"), [values]);
  const reservedKeySet = useMemo(() => new Set(reservedKeys.map((key) => key.trim().toUpperCase()).filter(Boolean)), [reservedKeys]);

  function update(id: string, patch: Partial<EnvVarPair>) {
    onChange(values.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  function addRow() {
    onChange([...values, { id: crypto.randomUUID(), key: "", value: "", secret: true }]);
  }

  function removeRow(id: string) {
    onChange(values.filter((item) => item.id !== id));
  }

  function importBulk(raw: string, mode: "replace" | "merge" = "replace") {
    const parsed = parseEnvFile(raw);
    const ignored: string[] = [];
    const imported = parsed
      .filter((item) => {
        if (!reservedKeySet.has(item.key.toUpperCase())) return true;
        ignored.push(item.key);
        return false;
      })
      .map((item) => ({
        id: crypto.randomUUID(),
        key: item.key,
        value: item.value,
        secret: true,
        source: "imported .env file",
        evidence: ["Imported by the user. You can edit or remove this value before deployment."],
      }));

    setIgnoredKeys([...new Set(ignored)]);
    setImportedKeys(imported.map((item) => item.key));
    if (mode === "replace") {
      onChange(imported);
      return;
    }

    const byKey = new Map(values.filter((item) => !reservedKeySet.has(item.key.toUpperCase())).map((item) => [item.key, item]));
    for (const item of imported) {
      byKey.set(item.key, { ...byKey.get(item.key), ...item });
    }
    onChange([...byKey.values()]);
  }

  async function importFile(file: File | undefined) {
    if (!file) return;
    const text = await file.text();
    importBulk(text, "merge");
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  return (
    <div className="rounded-[24px] border border-white/5 bg-white/[0.025] p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.22em] text-cyan-200/60">Environment</p>
          <h3 className="mt-1 text-lg font-semibold tracking-[-0.03em] text-white">Runtime variables</h3>
        </div>
        <div className="flex gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".env,.txt,text/plain"
            className="hidden"
            onChange={(event) => void importFile(event.target.files?.[0])}
          />
          <button type="button" onClick={() => fileInputRef.current?.click()} className="rounded-xl border border-white/5 bg-white/[0.04] px-3 py-2 text-sm text-white/70 transition-all duration-200 hover:text-white">
            Import .env file
          </button>
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
      {ignoredKeys.length > 0 && (
        <div className="mb-4 rounded-2xl border border-cyan-300/10 bg-cyan-300/[0.035] p-3 text-xs leading-5 text-cyan-100/75">
          Ignored platform-managed variables from import because b3cloud will inject them at runtime:
          <span className="ml-1 font-mono">{ignoredKeys.join(", ")}</span>
        </div>
      )}
      {importedKeys.length > 0 && (
        <div className="mb-4 rounded-2xl border border-emerald-300/10 bg-emerald-300/[0.035] p-3 text-xs leading-5 text-emerald-100/75">
          Imported editable variables:
          <span className="ml-1 font-mono">{importedKeys.join(", ")}</span>
        </div>
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

function parseEnvFile(raw: string): Array<{ key: string; value: string }> {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.replace(/^export\s+/, ""))
    .map((line) => {
      const separator = line.indexOf("=");
      if (separator < 1) return null;
      const key = line.slice(0, separator).trim();
      const value = unquoteEnvValue(line.slice(separator + 1).trim());
      return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? { key, value } : null;
    })
    .filter((item): item is { key: string; value: string } => Boolean(item));
}

function unquoteEnvValue(value: string): string {
  if (value.length < 2) return value;
  const quote = value[0];
  if ((quote !== "\"" && quote !== "'") || value[value.length - 1] !== quote) {
    return value;
  }
  const unquoted = value.slice(1, -1);
  return quote === "\"" ? unquoted.replace(/\\n/g, "\n").replace(/\\"/g, "\"") : unquoted;
}
