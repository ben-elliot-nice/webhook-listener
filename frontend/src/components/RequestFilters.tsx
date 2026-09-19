import { ALL, type RequestFilter } from '../lib/filterRequests'

interface RequestFiltersProps {
  filter: RequestFilter
  onChange: (filter: RequestFilter) => void
  methodOptions: string[]
  contentTypeOptions: string[]
}

export function RequestFilters({ filter, onChange, methodOptions, contentTypeOptions }: RequestFiltersProps) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <select
        value={filter.method}
        onChange={(e) => onChange({ ...filter, method: e.target.value })}
        className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
      >
        <option value={ALL}>All methods</option>
        {methodOptions.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>

      <select
        value={filter.contentType}
        onChange={(e) => onChange({ ...filter, contentType: e.target.value })}
        className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
      >
        <option value={ALL}>All content types</option>
        {contentTypeOptions.map((ct) => (
          <option key={ct} value={ct}>
            {ct}
          </option>
        ))}
      </select>

      <input
        type="search"
        value={filter.search}
        onChange={(e) => onChange({ ...filter, search: e.target.value })}
        placeholder="Search body, headers, query params…"
        className="min-w-[240px] flex-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 placeholder:text-slate-400 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:placeholder:text-slate-400"
      />
    </div>
  )
}
