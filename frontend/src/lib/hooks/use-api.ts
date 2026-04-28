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
  Profile,
  Resume,
  TailorRequest,
  TailorResponse,
} from "@/lib/types";

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
  const fetcher = useAuthedFetch();
  const queryClient = useQueryClient();

  return useMutation<
    { applicationId: string; documentId: string; matchScore: number },
    Error,
    { payload: TailorRequest; onProgress?: (event: string, data: any) => void; onError?: (error: Error) => void }
  >({
    mutationFn: async ({ payload, onProgress, onError }) => {
      return new Promise((resolve, reject) => {
        const controller = new AbortController();
        const signal = controller.signal;

        const doFetch = async () => {
          try {
            const token = await (window as any).clerk?.getToken?.() || '';
            const url = buildApiUrl("/api/v1/applications/tailor/stream");
            
            const response = await fetch(url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
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

            while (true) {
              if (signal.aborted) {
                reader.cancel();
                reject(new Error("Request aborted"));
                return;
              }

              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });

              const lines = buffer.split("\n\n");
              buffer = lines.pop() || "";

              for (const line of lines) {
                if (!line.trim()) continue;
                
                const eventMatch = line.match(/^event:\\s*(.+)$/);
                const dataMatch = line.match(/^data:\\s*(.+)$/);
                
                if (dataMatch) {
                  try {
                    const data = JSON.parse(dataMatch[1]);
                    const event = eventMatch ? eventMatch[1] : "message";
                    
                    onProgress?.(event, data);

                    if (event === "result" || event === "error") {
                      if (event === "error") {
                        reject(new Error(data.message || "Tailor failed"));
                        return;
                      }
                      
                      queryClient.invalidateQueries({ queryKey: ["applications"] });
                      queryClient.invalidateQueries({ queryKey: ["application", data.app?.id] });
                      queryClient.invalidateQueries({ queryKey: ["resumes"] });
                      queryClient.invalidateQueries({ queryKey: ["dashboard-stats"] });
                      queryClient.invalidateQueries({ queryKey: ["profile"] });
                      
                      resolve({
                        applicationId: data.app?.id,
                        documentId: data.tailored?.id,
                        matchScore: data.matchScore,
                      });
                      return;
                    }
                  } catch (e) {
                    // Ignore JSON parse errors for non-data lines
                  }
                }
              }
            }

            reject(new Error("Stream ended without result"));
          } catch (error) {
            onError?.(error as Error);
            reject(error);
          }
        };

        doFetch();

        return () => {
          controller.abort();
        };
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
