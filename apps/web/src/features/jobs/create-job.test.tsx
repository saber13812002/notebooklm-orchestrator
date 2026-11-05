import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { CreateJobPage } from "./create-job";
import { ToastProvider } from "@/components/ui/toast";
import type { Account, SessionsOverview } from "@/lib/api";

/**
 * Create-job preflight (P0 audio recovery): the job runner only accepts
 * accounts whose session is AUTHENTICATED and verified within the TTL.
 * The page must surface that state BEFORE submit — disabling the button
 * and pointing the user to /accounts — instead of letting the job fail
 * in the queue with errorClass "auth".
 */

const account = (over: Partial<Account> = {}): Account => ({
  id: "acc_1",
  label: "sas",
  displayEmail: "sas@example.com",
  status: "ACTIVE",
  enabled: true,
  hasAuth: false,
  lastSuccessAt: null,
  lastError: null,
  quotaNote: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  isDefault: false,
  ...over,
});

const sessionView = (accountId: string, usable: boolean, label = "sas") => ({
  accountId,
  account: {
    id: accountId,
    label,
    enabled: true,
    displayEmail: "sas@example.com",
    authSecretRef: null,
    authProfile: null,
  },
  session: {
    id: "sess_1",
    accountId,
    provider: "python-worker",
    profile: "default",
    email: null,
    state: usable ? ("AUTHENTICATED" as const) : ("AUTH_REQUIRED" as const),
    lastVerifiedAt: null,
    lastError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  sessionUsable: usable,
  hasStoredFile: false,
});

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function mockApi(
  fetchMock: Mock,
  data: { accounts?: Account[]; sessions?: SessionsOverview },
): void {
  fetchMock.mockImplementation((url: unknown) => {
    const u = String(url);
    let payload: unknown = {};
    if (u.endsWith("/api/accounts")) payload = data.accounts ?? [];
    else if (u.endsWith("/api/sessions")) payload = data.sessions ?? { sessions: [] };
    else if (u.endsWith("/api/proxies")) payload = [];
    else if (u.endsWith("/api/settings"))
      payload = {
        settings: { jobsMaxAttemptsDefault: 3, jobsMaxPromptChars: 20_000 },
        defaults: {
          jobs_max_attempts_default: 3,
          jobs_max_prompt_chars: 20_000,
          max_text_chars: 200_000,
        },
      };
    else if (u.endsWith("/api/notebooks/from-text"))
      // H1: 202-shaped creation response (same contract as the real endpoint).
      return Promise.resolve(
        new Response(
          JSON.stringify({
            jobId: "j_test12345678901234567890123456ab",
            status: "CREATED",
            correlationId: null,
            createdAt: "2026-11-05T00:00:00.000Z",
            statusUrl: "/api/jobs/j_test12345678901234567890123456ab",
          }),
          { status: 202, headers: { "content-type": "application/json" } },
        ),
      );
    return Promise.resolve(jsonResponse(payload));
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/jobs/new"]}>
      <ToastProvider>
        <CreateJobPage />
      </ToastProvider>
    </MemoryRouter>,
  );
}

const submitButton = () => screen.getByRole("button", { name: /ایجاد درخواست/ });
const promptField = () => screen.getByRole("textbox", { name: /سؤال \/ دستور/ });
const sessionAlert = () => screen.getByRole("alert");

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CreateJobPage session preflight", () => {
  it("blocks submit and links to /accounts when no account has a usable session", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mockApi(fetchMock, {
      accounts: [account()],
      sessions: {
        provider: "python-worker",
        interactiveLogin: true,
        sessions: [sessionView("acc_1", false)],
      },
    });
    renderPage();

    await waitFor(() => expect(sessionAlert()).toBeInTheDocument());
    expect(sessionAlert()).toHaveTextContent(/جلسه‌ی معتبر و تأییدشده ندارند/);
    expect(screen.getByRole("link", { name: /رفتن به صفحه‌ی حساب‌ها/ })).toHaveAttribute(
      "href",
      "/accounts",
    );
    expect(submitButton()).toBeDisabled();

    await user.type(promptField(), "خلاصه کن");
    expect(submitButton()).toBeDisabled();
  });

  it("blocks submit for an explicitly selected unusable account, even when another account is usable", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mockApi(fetchMock, {
      accounts: [account(), account({ id: "acc_2", label: "second" })],
      sessions: {
        provider: "python-worker",
        interactiveLogin: true,
        sessions: [sessionView("acc_1", false), sessionView("acc_2", true, "second")],
      },
    });
    renderPage();

    // Type a prompt first: canSubmit also requires a non-empty prompt.
    await user.type(promptField(), "خلاصه کن");

    // Auto mode: at least one usable account exists -> no block.
    await waitFor(() => expect(submitButton()).toBeEnabled());

    // Select the unusable account: explicit preference is not switchable.
    await user.selectOptions(screen.getByLabelText(/حساب گوگل/), "acc_1");
    await waitFor(() => expect(submitButton()).toBeDisabled());
    expect(sessionAlert()).toHaveTextContent(/حساب انتخابی \(sas\)/);
  });

  it("allows submit when the account has a usable session", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mockApi(fetchMock, {
      accounts: [account()],
      sessions: {
        provider: "python-worker",
        interactiveLogin: true,
        sessions: [sessionView("acc_1", true)],
      },
    });
    renderPage();

    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    await user.type(promptField(), "خلاصه کن");
    expect(submitButton()).toBeEnabled();
    await user.click(submitButton());

    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes("/api/jobs"))).toBe(true);
    });
  });

  it("stays enabled before session data loads (no false alarm)", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    let resolveAccounts: ((v: Response) => void) | undefined;
    fetchMock.mockImplementation((url: unknown) => {
      const u = String(url);
      if (u.endsWith("/api/accounts")) {
        return new Promise<Response>((res) => {
          resolveAccounts = () => res(jsonResponse([account()]));
        });
      }
      if (u.endsWith("/api/sessions")) return Promise.resolve(jsonResponse({ sessions: [] }));
      if (u.endsWith("/api/proxies")) return Promise.resolve(jsonResponse([]));
      if (u.endsWith("/api/settings"))
        return Promise.resolve(jsonResponse({ settings: { jobsMaxPromptChars: 20_000 } }));
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    // Accounts + sessions not resolved yet: no alert, button enabled once
    // the prompt is typed.
    await user.type(promptField(), "خلاصه کن");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(submitButton()).toBeEnabled();

    // Resolve the deferred accounts fetch (settles state within act).
    await act(async () => {
      resolveAccounts?.(jsonResponse([account()]));
    });
    // Now that accounts arrived with no usable sessions, the block kicks in.
    await waitFor(() => expect(submitButton()).toBeDisabled());
  });
});

describe("CreateJobPage text mode (H1)", () => {
  it("submits via POST /api/notebooks/from-text with an empty summary.prompt", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mockApi(fetchMock, {
      accounts: [account()],
      sessions: {
        provider: "python-worker",
        interactiveLogin: true,
        sessions: [sessionView("acc_1", true)],
      },
    });
    renderPage();

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());

    // Switch to text mode: the prompt becomes optional, the text is required.
    await user.click(screen.getByRole("button", { name: /متن مستقیم/ }));
    expect(submitButton()).toBeDisabled(); // no text yet

    const textArea = screen.getByLabelText(/متن منبع/);
    await user.type(textArea, "درود بر شما\nاین یک متن آزمایشی است.");
    await waitFor(() => expect(submitButton()).toBeEnabled());
    await user.click(submitButton());

    await waitFor(() => {
      const fromTextCalls = fetchMock.mock.calls.filter((c) =>
        String(c[0]).includes("/api/notebooks/from-text"),
      );
      expect(fromTextCalls).toHaveLength(1);
      const init = fromTextCalls[0]?.[1] as RequestInit;
      expect(init.method).toBe("POST");
      const body = JSON.parse(String(init.body)) as {
        text: string;
        title?: string;
        summary: { enabled: boolean; prompt: string | null };
      };
      expect(body.text).toBe("درود بر شما\nاین یک متن آزمایشی است.");
      expect(body.summary).toEqual({ enabled: true, prompt: null });
      // No multipart /api/jobs call in text mode.
      const jobCalls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/api/jobs"));
      expect(jobCalls).toHaveLength(0);
    });
  });
});
