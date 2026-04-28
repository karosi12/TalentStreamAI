"use client";

import { useAuth } from "@clerk/react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";

import { apiFetch } from "@/lib/api";
import { buildApiUrl, ApiError } from "@/lib/api";
import type {
  Application,
  DashboardStats,
  GapItem,
  MatchAnalysis,
  Profile,
  Resume,
  TailorRequest,
  TailorResponse,
} from "@/lib/types";

function normalizeSseNewlines(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** One SSE message (after optional CRLF normalization). */
function parseSseMessageBlock(block: string): { event: string; dataRaw: string } | null {
  const lines = block.trimEnd().split("\n");
  let eventName = "message";
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return null;
  return { event: eventName, dataRaw: dataLines.join("\n").trim() };
}

/**
 * Leave `buffer` as the trailing incomplete slice; return complete `\n\n`-delimited blocks.
 */
function pullCompleteSseBlocks(buffer: string): { pending: string; blocks: string[] } {
  const n = normalizeSseNewlines(buffer);
  const sep = n.lastIndexOf("\n\n");
  if (sep === -1) {
    return { pending: n, blocks: [] };
  }
  const head = n.slice(0, sep);
  const pending = n.slice(sep + 2);
  const blocks = head.split("\n\n").filter((b) => b.trim());
  return { pending, blocks };
}

function mapTailorStreamPayload(raw: unknown): TailorResponse {
  const data = raw as Record<string, unknown>;
  const app = (data.app ?? {}) as Record<string, unknown>;
  const tailored = (data.tailored ?? {}) as Record<string, unknown>;
  const de = (data.draft_email ?? {}) as Record<string, unknown>;
  const matchScore = Number(data.match_score ?? app.match_score ?? 0);
  const analysis = (data.analysis ?? null) as MatchAnalysis | null;
  const gaps = (Array.isArray(data.gaps) ? data.gaps : []) as GapItem[];
  const appId = String(app.id ?? "");
  const docId = String(tailored.id ?? "");
  return {
    applicationId: appId,
    matchScore,
    resume: {
      id: docId,
      content: String(tailored.text ?? ""),
      title: String(app.position ?? "") || "Tailored resume",
      isBase: false,
      createdAt: new Date().toISOString(),
      applicationId: appId,
    },
    coverLetter: String(data.cover_letter ?? ""),
    draftEmail: {
      subject: String(de.subject ?? "Application"),
      body: String(de.body ?? ""),
    },
    gaps,
    analysis: analysis ?? {
      originalScore: 60,
      tailoredScore: matchScore,
      improvement: Math.max(0, matchScore - 60),
      whatWeImproved: [],
      strengths: [],
      remainingDeficits: [],
      matchedKeywords: [],
      missingKeywords: [],
      suggestions: [],
    },
  };
}

function useAuthedFetch() {
  const { getToken } = useAuth();

  return async function authedFetch<T>(
    path: string,
    init?: Parameters<typeof apiFetch>[1],
  ): Promise<T> {
    const token = await getToken();
    return apiFetch<T>(path, { ...init, token });
  };
}

export function useProfile(
  opts?: Omit<UseQueryOptions<Profile>, "queryKey" | "queryFn">,
) {
  const fetcher = useAuthedFetch();
  return useQuery<Profile>({
    queryKey: ["profile"],
    queryFn: () => fetcher<Profile>("/api/v1/profile"),
    ...opts,
  });
}

export function useDashboardStats() {
  const fetcher = useAuthedFetch();
  return useQuery<DashboardStats>({
    queryKey: ["dashboard-stats"],
    queryFn: () => fetcher<DashboardStats>("/api/v1/dashboard/stats"),
  });
}

export function useApplications() {
  const fetcher = useAuthedFetch();
  return useQuery<Application[]>({
    queryKey: ["applications"],
    queryFn: () => fetcher<Application[]>("/api/v1/applications"),
  });
}

export function useApplication(id: string | undefined) {
  const fetcher = useAuthedFetch();
  return useQuery<Application | undefined>({
    queryKey: ["application", id],
    enabled: Boolean(id),
    queryFn: () => fetcher<Application>(`/api/v1/applications/${id}`),
  });
}

export function useResumes() {
  const fetcher = useAuthedFetch();
  return useQuery<Resume[]>({
    queryKey: ["resumes"],
    queryFn: () => fetcher<Resume[]>("/api/v1/resumes"),
  });
}

export function useResume(id: string | undefined) {
  const fetcher = useAuthedFetch();
  return useQuery<Resume | undefined>({
    queryKey: ["resume", id],
    enabled: Boolean(id),
    queryFn: () => fetcher<Resume>(`/api/v1/resumes/${id}`),
  });
}

export function useTailorApplication() {
  const fetcher = useAuthedFetch();
  const queryClient = useQueryClient();

  return useMutation<TailorResponse, Error, TailorRequest>({
    mutationFn: (payload) =>
      fetcher<TailorResponse>("/api/v1/applications/tailor", {
        method: "POST",
        body: payload,
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["applications"] });
      queryClient.invalidateQueries({ queryKey: ["application", data.applicationId] });
      queryClient.invalidateQueries({ queryKey: ["resumes"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-stats"] });
      queryClient.invalidateQueries({ queryKey: ["profile"] });
    },
  });
}

/**
 * Streaming version of useTailorApplication for production environments.
 * Uses SSE (Server-Sent Events) to receive incremental progress updates.
 * 
 * @param onProgress - Callback receiving SSE events { event, data }
 * @param onError - Callback for connection errors
 */
export function useTailorApplicationStream() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  return useMutation<
    TailorResponse,
    Error,
    { payload: TailorRequest; onProgress?: (event: string, data: unknown) => void; onError?: (error: Error) => void }
  >({
    mutationFn: async ({ payload, onProgress, onError }) => {
      return new Promise((resolve, reject) => {
        const controller = new AbortController();
        const signal = controller.signal;

        const doFetch = async () => {
          try {
            const url = buildApiUrl("/api/v1/applications/tailor/stream");
            const token = await getToken();
            
            const response = await fetch(url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: "text/event-stream",
                ...(token ? { "Authorization": `Bearer ${token}` } : {}),
              },
              body: JSON.stringify(payload),
              signal,
            });

            if (!response.ok) {
              const text = await response.text();
              let message = response.statusText;
              try {
                const parsed = JSON.parse(text);
                message = parsed.detail || message;
              } catch {}
              throw new ApiError(message, response.status);
            }

            if (!response.body) {
              throw new Error("ReadableStream not supported in this browser");
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            const handleParsedEvent = (event: string, data: unknown): boolean => {
              onProgress?.(event, data);
              if (event === "error") {
                const msg =
                  typeof data === "object" &&
                  data !== null &&
                  "message" in data &&
                  typeof (data as { message: unknown }).message === "string"
                    ? (data as { message: string }).message
                    : "Tailor failed";
                reject(new Error(msg));
                return true;
              }
              if (event === "result") {
                queryClient.invalidateQueries({ queryKey: ["applications"] });
                const appId =
                  typeof data === "object" &&
                  data !== null &&
                  "app" in data &&
                  typeof (data as { app: { id?: string } }).app?.id === "string"
                    ? (data as { app: { id: string } }).app.id
                    : undefined;
                if (appId) {
                  queryClient.invalidateQueries({ queryKey: ["application", appId] });
                }
                queryClient.invalidateQueries({ queryKey: ["resumes"] });
                queryClient.invalidateQueries({ queryKey: ["dashboard-stats"] });
                queryClient.invalidateQueries({ queryKey: ["profile"] });
                resolve(mapTailorStreamPayload(data));
                return true;
              }
              return false;
            };

            const dispatchBlock = (block: string): boolean => {
              const frame = parseSseMessageBlock(block);
              if (!frame) return false;
              try {
                const data = JSON.parse(frame.dataRaw) as unknown;
                return handleParsedEvent(frame.event, data);
              } catch {
                return false;
              }
            };

            const drainCompleteBlocks = (): boolean => {
              const { pending, blocks } = pullCompleteSseBlocks(buffer);
              buffer = pending;
              for (const block of blocks) {
                if (dispatchBlock(block)) return true;
              }
              return false;
            };

            while (true) {
              if (signal.aborted) {
                reader.cancel();
                reject(new Error("Request aborted"));
                return;
              }

              const { done, value } = await reader.read();
              if (value) {
                buffer = normalizeSseNewlines(
                  buffer + decoder.decode(value, { stream: true }),
                );
              }
              if (drainCompleteBlocks()) return;

              if (done) {
                buffer = normalizeSseNewlines(buffer + decoder.decode());
                const tailBlocks = buffer.split("\n\n").filter((b) => b.trim());
                buffer = "";
                for (let i = 0; i < tailBlocks.length; i++) {
                  const block = tailBlocks[i];
                  const isLast = i === tailBlocks.length - 1;
                  if (isLast && !block.includes("data:")) continue;
                  if (dispatchBlock(block)) return;
                }
                reject(new Error("Stream ended without result"));
                return;
              }
            }
          } catch (error) {
            onError?.(error as Error);
            reject(error);
          }
        };

        void doFetch();
      });
    },
  });
}

export function useUploadBaseResume() {
  const fetcher = useAuthedFetch();
  const queryClient = useQueryClient();

  return useMutation<Resume, Error, File>({
    mutationFn: async (file) => {
      const form = new FormData();
      form.append("file", file);
      return fetcher<Resume>("/api/v1/profile/base-resume", {
        method: "POST",
        body: form,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["profile"] });
      queryClient.invalidateQueries({ queryKey: ["resumes"] });
      queryClient.invalidateQueries({ queryKey: ["resume"] });
    },
  });
}

/** Upload a resume file without making it the profile base (see POST /api/v1/resumes). */
export function useUploadResume() {
  const fetcher = useAuthedFetch();
  const queryClient = useQueryClient();

  return useMutation<Resume, Error, File>({
    mutationFn: async (file) => {
      const form = new FormData();
      form.append("file", file);
      return fetcher<Resume>("/api/v1/resumes", {
        method: "POST",
        body: form,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["profile"] });
      queryClient.invalidateQueries({ queryKey: ["resumes"] });
      queryClient.invalidateQueries({ queryKey: ["resume"] });
    },
  });
}

export function useSetBaseResume() {
  const fetcher = useAuthedFetch();
  const queryClient = useQueryClient();

  return useMutation<Profile, Error, string>({
    mutationFn: (resumeId) =>
      fetcher<Profile>("/api/v1/profile", {
        method: "PATCH",
        body: { baseResumeId: resumeId },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["profile"] });
      queryClient.invalidateQueries({ queryKey: ["resumes"] });
      queryClient.invalidateQueries({ queryKey: ["resume"] });
    },
  });
}
