import { Info, Plus, Trash2 } from "lucide-react";
import type {
  WorkspaceSecretSummary,
  WorkspaceSecretUsage,
} from "@dohc/workspace-contracts/workspace-secrets";
import type { SecretDraft } from "../settings/WorkspaceSecretsSettings";
import { IconButton, SecondaryButton } from "../ui/controls";
import { StatusLine } from "./AutomationParts";
import type { AutomationStep, AutomationValue } from "./automationSentence";

export type HttpStep = Extract<AutomationStep, { kind: "http" }>;

type Shown = { id: string; text: string } | null;

const MAX_HEADERS = 16;

const inputClass =
  "w-full rounded-md border border-line bg-bg px-2 py-1 text-[13px] text-ink placeholder:text-subtle focus:border-ink";
const selectClass =
  "w-full rounded-md border border-line bg-bg px-1.5 py-1 text-[13px] text-ink focus:border-ink";
const formulaClass = `${inputClass} font-mono text-[12px]`;

const invalid = (shown: Shown) =>
  shown === null ? {} : { "aria-invalid": true, "aria-describedby": shown.id };

function Problem({ shown }: { shown: Shown }) {
  if (shown === null) return null;
  return (
    <p id={shown.id} data-problem className="m-0 mt-1 text-[12px] leading-snug text-danger">
      {shown.text}
    </p>
  );
}

function hostOf(url: string): string[] {
  try {
    return [new URL(url).hostname];
  } catch {
    return [];
  }
}

function NewSecretButton(props: { label: string; onClick: () => void }) {
  return (
    <SecondaryButton
      size="compact"
      className="flex items-center gap-1 self-start"
      onClick={props.onClick}
    >
      <Plus size={12} aria-hidden />
      {props.label}
    </SecondaryButton>
  );
}

function SimpleValueRow(props: {
  label: string;
  value: AutomationValue;
  onChange: (value: AutomationValue) => void;
}) {
  const isFormula = props.value.kind === "formula";
  const textValue =
    props.value.kind === "formula"
      ? props.value.expression
      : props.value.value === null
        ? ""
        : Array.isArray(props.value.value)
          ? props.value.value.join(", ")
          : String(props.value.value);

  return (
    <div className="flex flex-col gap-1">
      <select
        aria-label={`${props.label}, kind`}
        value={isFormula ? "formula" : "text"}
        onChange={(event) => {
          if (event.target.value === "formula") {
            props.onChange({ kind: "formula", expression: textValue });
          } else {
            props.onChange({ kind: "literal", value: textValue });
          }
        }}
        className={selectClass}
      >
        <option value="text">Text</option>
        <option value="formula">Formula</option>
      </select>
      <input
        aria-label={props.label}
        value={textValue}
        spellCheck={false}
        placeholder={isFormula ? "record.Title" : "Value"}
        onChange={(event) =>
          props.onChange(
            isFormula
              ? { kind: "formula", expression: event.target.value }
              : { kind: "literal", value: event.target.value },
          )
        }
        className={isFormula ? formulaClass : inputClass}
      />
    </div>
  );
}

export function HttpStepEditor(props: {
  number: number;
  stepKey: number;
  step: HttpStep;
  secrets: readonly WorkspaceSecretSummary[] | null;
  secretsUnavailable: string | null;
  problem: (key: string) => Shown;
  onChange: (next: HttpStep) => void;
  onAddSecret?: (draft: SecretDraft, apply: (name: string) => void) => void;
}) {
  const { number, stepKey, step, problem, onChange, onAddSecret } = props;
  const savedNames = new Set((props.secrets ?? []).map((secret) => secret.name));
  const addSecret = (named: string, usage: WorkspaceSecretUsage, apply: (name: string) => void) =>
    onAddSecret?.(
      {
        name: named !== "" && !savedNames.has(named) ? named : "",
        usage,
        hosts: usage === "http-header" && step.url.kind === "literal" ? hostOf(step.url.url) : [],
      },
      apply,
    );
  const urlSecrets = (props.secrets ?? []).filter((secret) => secret.usage === "http-url");
  const headerSecrets = (props.secrets ?? []).filter((secret) => secret.usage === "http-header");
  const totalHeaders = step.headers.length + step.secretHeaders.length;
  const urlProblem = problem(`step-${stepKey}/http`);
  const headersProblem = problem(`step-${stepKey}/headers`);
  const secretHeadersProblem = problem(`step-${stepKey}/secret-headers`);
  const bodyProblem = problem(`step-${stepKey}/body`);
  const methodProblem = problem(`step-${stepKey}/method`);
  const asProblem = problem(`step-${stepKey}/as`);
  const bodyKind = step.body === null ? "none" : step.body.kind;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <div className="flex flex-col gap-1">
          <select
            aria-label={`Step ${number}, method`}
            value={step.method}
            onChange={(event) =>
              onChange(
                event.target.value === "GET"
                  ? { ...step, method: "GET", body: null }
                  : { ...step, method: "POST" },
              )
            }
            className={selectClass}
            {...invalid(methodProblem)}
          >
            <option value="POST">POST: send data</option>
            <option value="GET">GET: read data</option>
          </select>
          <Problem shown={methodProblem} />
          <select
            aria-label={`Step ${number}, destination type`}
            value={step.url.kind}
            onChange={(event) => {
              const kind = event.target.value;
              if (kind === "secret") {
                onChange({
                  ...step,
                  url: { kind: "secret", secret: urlSecrets[0]?.name ?? "" },
                });
              } else {
                onChange({ ...step, url: { kind: "literal", url: "" } });
              }
            }}
            className={selectClass}
          >
            <option value="literal">Link</option>
            <option value="secret">Secret webhook link</option>
          </select>
          {step.url.kind === "literal" ? (
            <input
              aria-label={`Step ${number}, webhook URL`}
              data-focus={`step-${stepKey}-first`}
              type="url"
              spellCheck={false}
              placeholder="https://example.com/webhook"
              value={step.url.url}
              onChange={(event) =>
                onChange({ ...step, url: { kind: "literal", url: event.target.value } })
              }
              className={inputClass}
              {...invalid(urlProblem)}
            />
          ) : (
            <select
              aria-label={`Step ${number}, webhook URL secret`}
              data-focus={`step-${stepKey}-first`}
              value={step.url.secret}
              onChange={(event) =>
                onChange({ ...step, url: { kind: "secret", secret: event.target.value } })
              }
              className={selectClass}
              {...invalid(urlProblem)}
            >
              <option value="" disabled>
                {urlSecrets.length === 0 ? "No webhook links saved yet" : "Choose a secret"}
              </option>
              {step.url.secret !== "" &&
              !urlSecrets.some(
                (secret) => step.url.kind === "secret" && secret.name === step.url.secret,
              ) ? (
                <option value={step.url.secret}>{step.url.secret}</option>
              ) : null}
              {urlSecrets.map((secret) => (
                <option key={secret.name} value={secret.name}>
                  {secret.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <Problem shown={urlProblem} />
        {step.url.kind === "secret" && onAddSecret ? (
          <NewSecretButton
            label="New webhook link"
            onClick={() => {
              const named = step.url.kind === "secret" ? step.url.secret : "";
              addSecret(named, "http-url", (secret) =>
                onChange({ ...step, url: { kind: "secret", secret } }),
              );
            }}
          />
        ) : step.url.kind === "secret" && urlSecrets.length === 0 && !props.secretsUnavailable ? (
          <p className="m-0 text-[12px] text-muted">
            Add a webhook link in Workspace Settings first.
          </p>
        ) : null}
      </div>

      {props.secretsUnavailable ? (
        <StatusLine tone="muted" icon={Info} label="Secrets unavailable">
          {props.secretsUnavailable}
        </StatusLine>
      ) : null}

      <div className="flex flex-col gap-1">
        <span className="text-[12px] font-medium text-muted">Headers</span>
        {step.headers.map((header, index) => (
          <div key={`h-${index}`} className="flex items-start gap-1">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <input
                aria-label={`Step ${number}, header ${index + 1} name`}
                value={header.name}
                spellCheck={false}
                placeholder="X-Event"
                onChange={(event) =>
                  onChange({
                    ...step,
                    headers: step.headers.map((entry, at) =>
                      at === index ? { ...entry, name: event.target.value } : entry,
                    ),
                  })
                }
                className={inputClass}
              />
              <SimpleValueRow
                label={`Step ${number}, header ${index + 1} value`}
                value={header.value}
                onChange={(value) =>
                  onChange({
                    ...step,
                    headers: step.headers.map((entry, at) =>
                      at === index ? { ...entry, value } : entry,
                    ),
                  })
                }
              />
            </div>
            <IconButton
              aria-label={`Remove header ${index + 1}`}
              title="Remove"
              onClick={() =>
                onChange({
                  ...step,
                  headers: step.headers.filter((_, at) => at !== index),
                })
              }
            >
              <Trash2 size={13} aria-hidden />
            </IconButton>
          </div>
        ))}
        <SecondaryButton
          size="compact"
          className="flex items-center gap-1 self-start"
          disabled={totalHeaders >= MAX_HEADERS}
          onClick={() =>
            onChange({
              ...step,
              headers: [...step.headers, { name: "", value: { kind: "literal", value: "" } }],
            })
          }
        >
          <Plus size={12} aria-hidden />
          Add header
        </SecondaryButton>
        <Problem shown={headersProblem} />
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[12px] font-medium text-muted">API keys</span>
        {step.secretHeaders.map((header, index) => (
          <div key={`sh-${index}`} className="flex items-start gap-1">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <input
                aria-label={`Step ${number}, secret header ${index + 1} name`}
                value={header.name}
                spellCheck={false}
                placeholder="Authorization"
                onChange={(event) =>
                  onChange({
                    ...step,
                    secretHeaders: step.secretHeaders.map((entry, at) =>
                      at === index ? { ...entry, name: event.target.value } : entry,
                    ),
                  })
                }
                className={inputClass}
              />
              <select
                aria-label={`Step ${number}, secret header ${index + 1} secret`}
                value={header.secret}
                onChange={(event) =>
                  onChange({
                    ...step,
                    secretHeaders: step.secretHeaders.map((entry, at) =>
                      at === index ? { ...entry, secret: event.target.value } : entry,
                    ),
                  })
                }
                className={selectClass}
              >
                <option value="" disabled>
                  {headerSecrets.length === 0 ? "No API keys saved yet" : "Choose a secret"}
                </option>
                {header.secret !== "" &&
                !headerSecrets.some((secret) => secret.name === header.secret) ? (
                  <option value={header.secret}>{header.secret}</option>
                ) : null}
                {headerSecrets.map((secret) => (
                  <option key={secret.name} value={secret.name}>
                    {secret.name} ({secret.allowedHosts.join(", ")})
                  </option>
                ))}
              </select>
              <input
                aria-label={`Step ${number}, secret header ${index + 1} prefix`}
                value={header.prefix ?? ""}
                spellCheck={false}
                placeholder="Optional prefix, e.g. Bearer "
                onChange={(event) =>
                  onChange({
                    ...step,
                    secretHeaders: step.secretHeaders.map((entry, at) =>
                      at === index
                        ? {
                            ...entry,
                            prefix: event.target.value === "" ? null : event.target.value,
                          }
                        : entry,
                    ),
                  })
                }
                className={inputClass}
              />
              {onAddSecret ? (
                <NewSecretButton
                  label="New API key"
                  onClick={() =>
                    addSecret(header.secret, "http-header", (secret) =>
                      onChange({
                        ...step,
                        secretHeaders: step.secretHeaders.map((entry, at) =>
                          at === index ? { ...entry, secret } : entry,
                        ),
                      }),
                    )
                  }
                />
              ) : null}
            </div>
            <IconButton
              aria-label={`Remove secret header ${index + 1}`}
              title="Remove"
              onClick={() =>
                onChange({
                  ...step,
                  secretHeaders: step.secretHeaders.filter((_, at) => at !== index),
                })
              }
            >
              <Trash2 size={13} aria-hidden />
            </IconButton>
          </div>
        ))}
        <SecondaryButton
          size="compact"
          className="flex items-center gap-1 self-start"
          disabled={totalHeaders >= MAX_HEADERS}
          onClick={() =>
            onChange({
              ...step,
              secretHeaders: [
                ...step.secretHeaders,
                { name: "Authorization", secret: headerSecrets[0]?.name ?? "", prefix: "Bearer " },
              ],
            })
          }
        >
          <Plus size={12} aria-hidden />
          Add API key header
        </SecondaryButton>
        <Problem shown={secretHeadersProblem} />
      </div>

      {step.method === "GET" ? null : (
        <div className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-muted">Body</span>
          <select
            aria-label={`Step ${number}, body type`}
            value={bodyKind}
            onChange={(event) => {
              const next = event.target.value;
              if (next === "none") {
                onChange({ ...step, body: null });
              } else if (next === "json") {
                onChange({
                  ...step,
                  body: {
                    kind: "json",
                    fields: [
                      { key: "title", value: { kind: "formula", expression: "record.Title" } },
                    ],
                  },
                });
              } else {
                onChange({ ...step, body: { kind: "text", template: "" } });
              }
            }}
            className={selectClass}
          >
            <option value="none">No body</option>
            <option value="json">JSON fields</option>
            <option value="text">Text template</option>
          </select>

          {step.body?.kind === "json" ? (
            <div className="flex flex-col gap-1.5 pt-1">
              {step.body.fields.map((entry, index) => (
                <div key={`bf-${index}`} className="flex items-start gap-1">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <input
                      aria-label={`Step ${number}, body field ${index + 1} name`}
                      value={entry.key}
                      spellCheck={false}
                      placeholder="Field name"
                      onChange={(event) =>
                        onChange({
                          ...step,
                          body: {
                            kind: "json",
                            fields:
                              step.body?.kind === "json"
                                ? step.body.fields.map((row, at) =>
                                    at === index ? { ...row, key: event.target.value } : row,
                                  )
                                : [],
                          },
                        })
                      }
                      className={inputClass}
                    />
                    <SimpleValueRow
                      label={`Step ${number}, body field ${index + 1} value`}
                      value={entry.value}
                      onChange={(value) =>
                        onChange({
                          ...step,
                          body: {
                            kind: "json",
                            fields:
                              step.body?.kind === "json"
                                ? step.body.fields.map((row, at) =>
                                    at === index ? { ...row, value } : row,
                                  )
                                : [],
                          },
                        })
                      }
                    />
                  </div>
                  <IconButton
                    aria-label={`Remove body field ${index + 1}`}
                    title="Remove"
                    onClick={() =>
                      onChange({
                        ...step,
                        body: {
                          kind: "json",
                          fields:
                            step.body?.kind === "json"
                              ? step.body.fields.filter((_, at) => at !== index)
                              : [],
                        },
                      })
                    }
                  >
                    <Trash2 size={13} aria-hidden />
                  </IconButton>
                </div>
              ))}
              <SecondaryButton
                size="compact"
                className="flex items-center gap-1 self-start"
                onClick={() =>
                  onChange({
                    ...step,
                    body: {
                      kind: "json",
                      fields:
                        step.body?.kind === "json"
                          ? [
                              ...step.body.fields,
                              { key: "", value: { kind: "literal", value: "" } },
                            ]
                          : [{ key: "", value: { kind: "literal", value: "" } }],
                    },
                  })
                }
              >
                <Plus size={12} aria-hidden />
                Add field
              </SecondaryButton>
            </div>
          ) : step.body?.kind === "text" ? (
            <textarea
              aria-label={`Step ${number}, body text`}
              rows={3}
              value={step.body.template}
              placeholder="Record {record.Title} was added."
              onChange={(event) =>
                onChange({ ...step, body: { kind: "text", template: event.target.value } })
              }
              className={`${inputClass} resize-y`}
              {...invalid(bodyProblem)}
            />
          ) : null}
          <Problem shown={bodyProblem} />
        </div>
      )}

      <label className="flex flex-col gap-1">
        <span className="text-[12px] font-medium text-muted">Save the answer as</span>
        <input
          aria-label={`Step ${number}, save the answer as`}
          value={step.as ?? ""}
          spellCheck={false}
          placeholder="Optional, such as stats"
          onChange={(event) =>
            onChange({ ...step, as: event.target.value === "" ? null : event.target.value })
          }
          className={`${inputClass} font-mono text-[12px]`}
          {...invalid(asProblem)}
        />
        <Problem shown={asProblem} />
        {step.as === null ? null : (
          <span className="text-[12px] text-muted">
            dohc reads the JSON answer, up to 192 KiB. Later steps use it in formulas, such as{" "}
            <code className="font-mono">{step.as}.count</code>.
          </span>
        )}
      </label>

      <StatusLine tone="muted" icon={Info} label="Confirmation required">
        Confirm this step with Allow before it sends. Runs only while this Collection is private.
      </StatusLine>
    </div>
  );
}
