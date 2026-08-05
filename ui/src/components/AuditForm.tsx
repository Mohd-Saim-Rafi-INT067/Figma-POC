import { useState } from 'react';
import type { Health } from '../types';

export interface FormValues {
  figmaFrameUrl: string;
  pageUrl: string;
  determinism: boolean;
}

interface Props {
  onSubmit: (values: FormValues) => void;
  disabled: boolean;
  health: Health | null;
  serverError: { field?: string; message: string; hint: string | null } | null;
}

/**
 * Client-side checks are for instant feedback only - the server is
 * authoritative and produces better messages (it reuses the CLI's own
 * parseFigmaUrl). These exist so a typo costs a second rather than a round
 * trip, not to duplicate validation.
 */
function quickCheck(values: FormValues): Partial<Record<keyof FormValues, string>> {
  const errors: Partial<Record<keyof FormValues, string>> = {};

  if (!values.figmaFrameUrl.trim()) {
    errors.figmaFrameUrl = 'Required.';
  } else {
    try {
      const url = new URL(values.figmaFrameUrl.trim());
      if (!/figma\.com$/.test(url.hostname.replace(/^www\./, ''))) {
        errors.figmaFrameUrl = "That doesn't look like a Figma URL.";
      } else if (!url.searchParams.get('node-id')) {
        errors.figmaFrameUrl =
          'That link points at the file, not a frame. In Figma: right-click the frame → Copy link to selection.';
      }
    } catch {
      errors.figmaFrameUrl = 'Not a valid URL.';
    }
  }

  if (!values.pageUrl.trim()) {
    errors.pageUrl = 'Required.';
  } else {
    try {
      const url = new URL(values.pageUrl.trim());
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        errors.pageUrl = 'Only http:// and https:// pages can be audited.';
      }
    } catch {
      errors.pageUrl = 'Not a valid URL — include https://';
    }
  }

  return errors;
}

const FieldError = ({ text }: { text: string }) => (
  <p className="mt-1.5 text-sm text-rose-700">{text}</p>
);

export function AuditForm({ onSubmit, disabled, health, serverError }: Props) {
  const [values, setValues] = useState<FormValues>({
    figmaFrameUrl: '',
    pageUrl: '',
    // Default ON: a run that never identified its dynamic regions reports
    // motion as defects. Costs 15-50s; the alternative is untrustworthy
    // findings. Uncheckable in Advanced for a quick look.
    determinism: true,
  });
  const [touched, setTouched] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const errors = quickCheck(values);
  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }));

  const errorFor = (field: keyof FormValues) => {
    if (serverError?.field === field) return serverError.message;
    if (touched && errors[field]) return errors[field];
    return null;
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (Object.keys(quickCheck(values)).length > 0) return;
    onSubmit({ ...values, figmaFrameUrl: values.figmaFrameUrl.trim(), pageUrl: values.pageUrl.trim() });
  };

  const inputClass = (field: keyof FormValues) =>
    [
      'w-full rounded-lg border px-3.5 py-2.5 text-[15px] outline-none transition',
      'placeholder:text-slate-400',
      errorFor(field)
        ? 'border-rose-300 bg-rose-50/40 focus:border-rose-400 focus:ring-4 focus:ring-rose-100'
        : 'border-slate-300 bg-white focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100',
    ].join(' ');

  return (
    <form onSubmit={submit} noValidate className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="space-y-5">
        <div>
          <label htmlFor="figma" className="block text-sm font-medium text-slate-800">
            Figma frame URL
          </label>
          <p className="mb-2 text-sm text-slate-500">
            Right-click the frame in Figma → Copy link to selection.
          </p>
          <input
            id="figma"
            type="text"
            spellCheck={false}
            className={inputClass('figmaFrameUrl')}
            placeholder="https://www.figma.com/design/…?node-id=1-234"
            value={values.figmaFrameUrl}
            onChange={(e) => set('figmaFrameUrl', e.target.value)}
            onBlur={() => setTouched(true)}
            disabled={disabled}
          />
          {errorFor('figmaFrameUrl') && <FieldError text={errorFor('figmaFrameUrl')!} />}
          {serverError?.field === 'figmaFrameUrl' && serverError.hint && (
            <p className="mt-1 text-sm text-slate-500">{serverError.hint}</p>
          )}
        </div>

        <div>
          <label htmlFor="page" className="block text-sm font-medium text-slate-800">
            Website URL
          </label>
          <p className="mb-2 text-sm text-slate-500">The implemented page to audit against that frame.</p>
          <input
            id="page"
            type="text"
            spellCheck={false}
            className={inputClass('pageUrl')}
            placeholder="https://example.com/"
            value={values.pageUrl}
            onChange={(e) => set('pageUrl', e.target.value)}
            onBlur={() => setTouched(true)}
            disabled={disabled}
          />
          {errorFor('pageUrl') && <FieldError text={errorFor('pageUrl')!} />}
          {serverError?.field === 'pageUrl' && serverError.hint && (
            <p className="mt-1 text-sm text-slate-500">{serverError.hint}</p>
          )}
        </div>

        <div>
          <button
            type="button"
            onClick={() => setAdvancedOpen((o) => !o)}
            className="text-sm text-slate-500 underline-offset-4 hover:text-slate-800 hover:underline"
          >
            {advancedOpen ? 'Hide' : 'Show'} advanced options
          </button>
          {advancedOpen && (
            <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-lg bg-slate-50 p-3.5">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-indigo-600"
                checked={values.determinism}
                onChange={(e) => set('determinism', e.target.checked)}
                disabled={disabled}
              />
              <span className="text-sm">
                <span className="font-medium text-slate-800">Run the determinism self-check</span>
                <span className="block text-slate-500">
                  Extracts the page a second time to identify animated and dynamic regions, so
                  motion is not reported as a defect. Adds roughly 15–50 seconds. Turning this off
                  makes findings faster but less trustworthy.
                </span>
              </span>
            </label>
          )}
        </div>

        {serverError && !serverError.field && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-3.5">
            <p className="text-sm font-medium text-rose-900">{serverError.message}</p>
            {serverError.hint && <p className="mt-1 text-sm text-rose-800">{serverError.hint}</p>}
          </div>
        )}

        {/* Warn BEFORE a 40-second run, not after it. */}
        {health && !health.figmaToken && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-3.5 text-sm text-rose-900">
            No Figma token is configured on the server. Set <code className="font-mono">FIGMA_TOKEN</code>{' '}
            in <code className="font-mono">.env</code> — audits cannot run without it.
          </div>
        )}
        {health && health.figmaToken && !health.llm && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3.5 text-sm text-amber-900">
            No language-model key is configured, so the report will have no written summary. Every score,
            issue and finding is still produced — they are computed, not generated.
          </div>
        )}

        <button
          type="submit"
          disabled={disabled}
          className="w-full rounded-lg bg-indigo-600 px-4 py-3 font-medium text-white transition hover:bg-indigo-700 focus:outline-none focus:ring-4 focus:ring-indigo-200 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {disabled ? 'Running…' : 'Generate Report'}
        </button>
      </div>
    </form>
  );
}
