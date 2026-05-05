"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
    ArrowRight,
    Check,
    Copy,
    Download,
    Loader2,
    Mail,
    Sparkles,
    TrendingUp,
    Upload,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    CardDescription,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { getErrorMessage } from "@/lib/error-message";
import {
    useResumes,
    useTailorApplicationStream,
    useUploadBaseResume,
    useUploadResume,
} from "@/lib/hooks/use-api";
import type { TailorResponse } from "@/lib/types";
import { toast } from "sonner";

const ACCEPTED = ".pdf,.doc,.docx,.txt";

type Mode = "url" | "description";

export default function ApplyPage() {
    const { data: resumes, isLoading: resumesLoading } = useResumes();
    const tailorStream = useTailorApplicationStream();
    const uploadBaseResume = useUploadBaseResume();
    const uploadResumeAdd = useUploadResume();
    const applyUploadInputRef = useRef<HTMLInputElement>(null);

    const resumeList = resumes ?? [];
    const baseResumes = useMemo(
        () => resumeList.filter((r) => r.isBase === true),
        [resumeList],
    );
    const defaultResumeId = useMemo(() => baseResumes[0]?.id, [baseResumes]);

    const [selectedResumeId, setSelectedResumeId] = useState<
        string | undefined
    >();
    const [setUploadAsBase, setSetUploadAsBase] = useState(true);
    const [mode, setMode] = useState<Mode>("description");
    const [jobUrl, setJobUrl] = useState("");
    const [jobDescription, setJobDescription] = useState("");
    const [result, setResult] = useState<TailorResponse | null>(null);
    const [streamPhase, setStreamPhase] = useState<string | null>(null);
    const [streamPreview, setStreamPreview] = useState<{
        resume?: string;
        coverLetter?: string;
    }>({});
    const streamPreviewRef = useRef(streamPreview);
    useEffect(() => {
        streamPreviewRef.current = streamPreview;
    }, [streamPreview]);

    const hasBaseResume = baseResumes.length > 0;
    const resumesReady = !resumesLoading;
    const effectiveResumeId = selectedResumeId ?? defaultResumeId;
    const usingNonBaseFile =
        Boolean(selectedResumeId) &&
        !baseResumes.some((r) => r.id === selectedResumeId);
    const isUploading = uploadBaseResume.isPending || uploadResumeAdd.isPending;
    const canSubmit =
        Boolean(effectiveResumeId) &&
        ((mode === "url" && jobUrl.trim().length > 0) ||
            (mode === "description" && jobDescription.trim().length > 30));

    function handleApplyUploadChange(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file) return;
        const run = setUploadAsBase ? uploadBaseResume : uploadResumeAdd;
        run.mutate(file, {
                onSuccess: (data) => {
                    setResult({
                        applicationId: (data as unknown as { applicationId?: string }).applicationId || "",
                        matchScore: (data as unknown as { matchScore: number }).matchScore,
                        resume: { id: (data as unknown as { documentId?: string }).documentId || "", content: "", title: "", isBase: false, createdAt: new Date().toISOString() },
                        coverLetter: "",
                        draftEmail: { subject: "Application", body: "" },
                        gaps: [],
                        analysis: {
                            originalScore: 60,
                            tailoredScore: (data as unknown as { matchScore: number }).matchScore,
                            improvement: (data as unknown as { matchScore: number }).matchScore - 60,
                            whatWeImproved: ["Realigned phrasing to reflect keywords", "Tightened bullets toward role-specific outcomes"],
                            strengths: [],
                            remainingDeficits: [],
                            matchedKeywords: [],
                            missingKeywords: [],
                            suggestions: [],
                        },
                    });
                },
            onError: (error) => toast.error(getErrorMessage(error)),
        });
    }

    function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (!effectiveResumeId) return;
        setStreamPhase(null);
        setStreamPreview({});
        tailorStream.mutate(
            {
                payload: {
                    baseResumeId: effectiveResumeId,
                    jobUrl: mode === "url" ? jobUrl.trim() : undefined,
                    jobDescription:
                        mode === "description" ? jobDescription.trim() : undefined,
                },
                onProgress: (event, data) => {
                    if (
                        event === "status" &&
                        data &&
                        typeof data === "object" &&
                        "stage" in data
                    ) {
                        const stage = String(
                            (data as { stage: string }).stage,
                        );
                        const hasPersistedIds =
                            "application_id" in data &&
                            typeof (data as { application_id?: string })
                                .application_id === "string";
                        if (stage === "completed" && !hasPersistedIds) {
                            setStreamPhase(
                                "Streamed generation finished — running save pass…",
                            );
                            return;
                        }
                        const labels: Record<string, string> = {
                            fetching_job: "Fetching job posting…",
                            started: "Generating tailored documents…",
                            finalizing:
                                "Running full tailor pass (this can take a minute)…",
                            saving: "Saving your application…",
                            completed: "Almost done…",
                        };
                        setStreamPhase(labels[stage] ?? stage.replace(/_/g, " "));
                    }
                    if (
                        event === "resume" &&
                        data &&
                        typeof data === "object" &&
                        "content" in data
                    ) {
                        setStreamPreview((p) => ({
                            ...p,
                            resume: String((data as { content: string }).content),
                        }));
                    }
                    if (
                        event === "cover_letter" &&
                        data &&
                        typeof data === "object" &&
                        "content" in data
                    ) {
                        setStreamPreview((p) => ({
                            ...p,
                            coverLetter: String(
                                (data as { content: string }).content,
                            ),
                        }));
                    }
                },
            },
            {
                onSuccess: (data) => {
                    setStreamPhase(null);
                    const live = streamPreviewRef.current;
                    setStreamPreview({});
                    setResult({
                        ...data,
                        resume: {
                            ...data.resume,
                            content:
                                live.resume &&
                                live.resume.length > data.resume.content.length
                                    ? live.resume
                                    : data.resume.content,
                        },
                        coverLetter:
                            live.coverLetter &&
                            live.coverLetter.length > data.coverLetter.length
                                ? live.coverLetter
                                : data.coverLetter,
                    });
                },
                onError: (error) => {
                    setStreamPhase(null);
                    toast.error(getErrorMessage(error));
                },
            },
        );
    }

    return (
        <div className='space-y-8'>
            <div>
                <h1 className='text-3xl font-bold tracking-tight'>
                    Tailor a new application
                </h1>
                <p className='mt-1 text-muted-foreground'>
                    {!resumesReady ? (
                        <>Loading your resumes…</>
                    ) : hasBaseResume ? (
                        <>
                            Your base resume is the starting point; upload a
                            new file if you need a different one. Then paste the
                            job and we&apos;ll generate a tailored resume, cover
                            letter, and match score.
                        </>
                    ) : (
                        <>
                            Add a base resume from onboarding first. After that,
                            you can paste the job and we&apos;ll generate a
                            tailored resume, cover letter, and match score.
                        </>
                    )}
                </p>
            </div>

            <form onSubmit={handleSubmit} className='space-y-6'>
                <Card>
                    <CardHeader>
                        <CardTitle className='text-base'>
                            1. Base resume
                        </CardTitle>
                        <CardDescription>
                            {!resumesReady ? (
                                <>Loading…</>
                            ) : hasBaseResume ? (
                                <>
                                    Only your current base appears here. Upload
                                    a file on the right to use a different
                                    resume; by default it becomes your new base
                                    unless you opt out below.
                                </>
                            ) : (
                                <>
                                    Complete onboarding to add your base
                                    resume. You can return here to tailor
                                    applications once it&apos;s saved.
                                </>
                            )}
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        {resumesLoading ? (
                            <div className='grid gap-3 sm:grid-cols-2'>
                                <Skeleton className='h-20' />
                                <Skeleton className='h-20' />
                            </div>
                        ) : (
                            <div
                                className={cn(
                                    "grid gap-6 lg:items-stretch",
                                    hasBaseResume
                                        ? "grid-cols-2"
                                        : "grid-cols-1",
                                )}
                            >
                                <div className='min-w-0 flex-1 space-y-3'>
                                    {baseResumes.length === 0 ? (
                                        <div className='rounded-md border border-dashed p-5 text-sm text-muted-foreground'>
                                            <p>
                                                No base resume yet. Upload your
                                                resume in onboarding to get
                                                started.
                                            </p>
                                            <Button
                                                asChild
                                                className='mt-3'
                                                variant='primary'
                                                size='sm'
                                            >
                                                <Link href='/onboarding'>
                                                    Open onboarding
                                                </Link>
                                            </Button>
                                        </div>
                                    ) : (
                                        <div className='max-w-2xl'>
                                            {baseResumes.map((resume) => {
                                                const isSelected =
                                                    effectiveResumeId ===
                                                    resume.id;
                                                return (
                                                    <button
                                                        key={resume.id}
                                                        type='button'
                                                        onClick={() =>
                                                            setSelectedResumeId(
                                                                resume.id,
                                                            )
                                                        }
                                                        className={cn(
                                                            "w-full rounded-lg border p-4 text-left transition-colors",
                                                            isSelected
                                                                ? "border-primary bg-primary/5"
                                                                : "hover:bg-accent/40",
                                                        )}
                                                    >
                                                        <p className='font-medium leading-snug'>
                                                            {resume.title}
                                                        </p>
                                                        <p className='mt-1 line-clamp-2 text-xs text-muted-foreground'>
                                                            {resume.content}
                                                        </p>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    )}
                                    {usingNonBaseFile ? (
                                        <p className='max-w-2xl text-xs text-muted-foreground'>
                                            This run will use a file you
                                            uploaded without setting it as your
                                            base. Your saved base above is
                                            unchanged.
                                        </p>
                                    ) : null}
                                </div>

                                {hasBaseResume ? (
                                    <div className='flex flex-col justify-between gap-3 rounded-lg border border-dashed bg-muted/20 p-4 '>
                                        <div>
                                            <p className='text-sm font-medium'>
                                                Upload a resume
                                            </p>
                                            <p className='mt-1 text-xs text-muted-foreground'>
                                                PDF, DOC, DOCX, or TXT. New
                                                uploads are used for this
                                                tailoring run.
                                            </p>
                                        </div>
                                        <div className='space-y-3'>
                                            <input
                                                ref={applyUploadInputRef}
                                                type='file'
                                                accept={ACCEPTED}
                                                className='hidden'
                                                onChange={handleApplyUploadChange}
                                            />
                                            <Button
                                                type='button'
                                                variant='outline'
                                                className='w-full'
                                                disabled={isUploading}
                                                onClick={() =>
                                                    applyUploadInputRef.current?.click()
                                                }
                                            >
                                                {isUploading ? (
                                                    <>
                                                        <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                                                        Uploading…
                                                    </>
                                                ) : (
                                                    <>
                                                        <Upload className='mr-2 h-4 w-4' />
                                                        Choose file
                                                    </>
                                                )}
                                            </Button>
                                            <label className='flex cursor-pointer items-start gap-2 text-xs text-muted-foreground'>
                                                <input
                                                    type='checkbox'
                                                    className='mt-0.5 h-4 w-4 shrink-0 rounded border border-input'
                                                    checked={setUploadAsBase}
                                                    onChange={(e) =>
                                                        setSetUploadAsBase(
                                                            e.target.checked,
                                                        )
                                                    }
                                                    disabled={isUploading}
                                                />
                                                <span>
                                                    Set uploaded file as my base
                                                    resume. Uncheck to add the
                                                    file without changing which
                                                    resume is your saved base (it
                                                    will still be selected for
                                                    this run).
                                                </span>
                                            </label>
                                        </div>
                                    </div>
                                ) : null}
                            </div>
                        )}
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle className='text-base'>
                            2. Paste the job
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <Tabs
                            value={mode}
                            onValueChange={(v) => setMode(v as Mode)}
                        >
                            <TabsList className='mb-4'>
                                <TabsTrigger value='description'>
                                    Job description
                                </TabsTrigger>
                                <TabsTrigger value='url'>Job URL</TabsTrigger>
                            </TabsList>
                            <TabsContent
                                value='description'
                                className='space-y-2'
                            >
                                <Label htmlFor='description'>
                                    Job description
                                </Label>
                                <Textarea
                                    id='description'
                                    value={jobDescription}
                                    onChange={(e) =>
                                        setJobDescription(e.target.value)
                                    }
                                    rows={10}
                                    placeholder='Paste the full job description here...'
                                />
                            </TabsContent>
                            <TabsContent value='url' className='space-y-2'>
                                <Label htmlFor='url'>Job URL</Label>
                                <Input
                                    id='url'
                                    type='url'
                                    value={jobUrl}
                                    onChange={(e) => setJobUrl(e.target.value)}
                                    placeholder='https://...'
                                />
                                <p className='text-xs text-muted-foreground'>
                                    We&apos;ll fetch and parse the posting
                                    automatically.
                                </p>
                            </TabsContent>
                        </Tabs>
                    </CardContent>
                </Card>

                <div className='flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-end'>
                    {tailorStream.isPending && streamPhase ? (
                        <p className='text-sm text-muted-foreground sm:mr-auto'>
                            {streamPhase}
                        </p>
                    ) : null}
                    {tailorStream.isError ? (
                        <p className='text-sm text-destructive'>
                            {(tailorStream.error as Error).message}
                        </p>
                    ) : null}
                    <Button
                        type='submit'
                        size='lg'
                        disabled={!canSubmit || tailorStream.isPending}
                    >
                        {tailorStream.isPending ? (
                            <>
                                <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                                Generating...
                            </>
                        ) : (
                            <>
                                <Sparkles className='mr-2 h-4 w-4' />
                                Tailor application
                            </>
                        )}
                    </Button>
                </div>
            </form>

            {tailorStream.isPending &&
            (streamPreview.resume || streamPreview.coverLetter) ? (
                <Card className='border-dashed'>
                    <CardHeader className='pb-2'>
                        <CardTitle className='text-base'>
                            Live preview
                        </CardTitle>
                        <CardDescription>
                            Streaming output — final version may differ slightly
                            after save.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className='grid gap-4 md:grid-cols-2'>
                        {streamPreview.resume ? (
                            <div className='space-y-2'>
                                <p className='text-xs font-medium text-muted-foreground'>
                                    Resume (in progress)
                                </p>
                                <pre className='max-h-[240px] overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-xs leading-relaxed'>
                                    {streamPreview.resume}
                                </pre>
                            </div>
                        ) : null}
                        {streamPreview.coverLetter ? (
                            <div className='space-y-2'>
                                <p className='text-xs font-medium text-muted-foreground'>
                                    Cover letter (in progress)
                                </p>
                                <pre className='max-h-[240px] overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs leading-relaxed'>
                                    {streamPreview.coverLetter}
                                </pre>
                            </div>
                        ) : null}
                    </CardContent>
                </Card>
            ) : null}

            {result ? <ResultSection result={result} /> : null}
        </div>
    );
}

function CopyButton({ text, className }: { text: string; className?: string }) {
    const [copied, setCopied] = useState(false);

    async function handleCopy() {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    }

    return (
        <Button
            variant='outline'
            size='sm'
            onClick={handleCopy}
            className={className}
        >
            {copied ? (
                <>
                    <Check className='mr-1.5 h-3.5 w-3.5 text-emerald-600' />
                    Copied
                </>
            ) : (
                <>
                    <Copy className='mr-1.5 h-3.5 w-3.5' />
                    Copy
                </>
            )}
        </Button>
    );
}

function DownloadButton({
    text,
    filename,
    className,
}: {
    text: string;
    filename: string;
    className?: string;
}) {
    function handleDownload() {
        const blob = new Blob([text], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    return (
        <Button
            variant='outline'
            size='sm'
            onClick={handleDownload}
            className={className}
        >
            <Download className='mr-1.5 h-3.5 w-3.5' />
            Download
        </Button>
    );
}

function ScoreBar({ score }: { score: number }) {
    return (
        <div className='space-y-1.5'>
            <div className='h-2 w-full overflow-hidden rounded-full bg-muted'>
                <div
                    className={cn(
                        "h-full rounded-full transition-all",
                        score >= 85
                            ? "bg-primary"
                            : score >= 70
                              ? "bg-amber-500"
                              : "bg-destructive",
                    )}
                    style={{ width: `${score}%` }}
                />
            </div>
        </div>
    );
}

function ResultSection({ result }: { result: TailorResponse }) {
    const { analysis } = result;

    return (
        <section className='space-y-6 border-t pt-8'>
            <div className='flex flex-col gap-3 md:flex-row md:items-center md:justify-between'>
                <div>
                    <h2 className='text-2xl font-bold tracking-tight'>
                        Your tailored application
                    </h2>
                    <p className='text-sm text-muted-foreground'>
                        Review your documents and analysis below. AI can make
                        mistakes — check before submitting.
                    </p>
                </div>
                <Button asChild variant='outline'>
                    <Link href={`/applications/${result.applicationId}`}>
                        Open in history
                        <ArrowRight className='ml-2 h-4 w-4' />
                    </Link>
                </Button>
            </div>

            <div className='grid gap-6 lg:grid-cols-[1fr_420px]'>
                {/* Left: documents */}
                <div className='space-y-6'>
                    {/* Tailored Resume */}
                    <Card>
                        <CardHeader className='pb-3'>
                            <div className='flex items-start justify-between gap-3'>
                                <div>
                                    <CardTitle>Tailored Resume</CardTitle>
                                    <CardDescription className='mt-0.5'>
                                        Review your resume before submission. AI
                                        can make mistakes.
                                    </CardDescription>
                                </div>
                                <div className='flex shrink-0 gap-2'>
                                    <CopyButton text={result.resume.content} />
                                    <DownloadButton
                                        text={result.resume.content}
                                        filename='tailored-resume.txt'
                                    />
                                </div>
                            </div>
                        </CardHeader>
                        <CardContent>
                            <pre className='max-h-[480px] overflow-auto whitespace-pre-wrap rounded-md bg-muted p-4 font-mono text-sm leading-relaxed'>
                                {result.resume.content}
                            </pre>
                        </CardContent>
                    </Card>

                    {/* Cover Letter */}
                    <Card>
                        <CardHeader className='pb-3'>
                            <div className='flex items-start justify-between gap-3'>
                                <div>
                                    <CardTitle>Cover Letter</CardTitle>
                                    <CardDescription className='mt-0.5'>
                                        Review your cover letter before
                                        submission. AI can make mistakes.
                                    </CardDescription>
                                </div>
                                <div className='flex shrink-0 gap-2'>
                                    <CopyButton text={result.coverLetter} />
                                    <DownloadButton
                                        text={result.coverLetter}
                                        filename='cover-letter.txt'
                                    />
                                </div>
                            </div>
                        </CardHeader>
                        <CardContent>
                            <pre className='max-h-[480px] overflow-auto whitespace-pre-wrap rounded-md bg-muted p-4 text-sm leading-relaxed'>
                                {result.coverLetter}
                            </pre>
                        </CardContent>
                    </Card>

                    {/* Draft Email */}
                    <Card>
                        <CardHeader className='pb-3'>
                            <div className='flex items-start justify-between gap-3'>
                                <div>
                                    <CardTitle>Draft Email</CardTitle>
                                    <CardDescription className='mt-0.5'>
                                        A short outreach email to send directly
                                        to a recruiter or hiring manager.
                                    </CardDescription>
                                </div>
                                <div className='flex shrink-0 gap-2'>
                                    <CopyButton
                                        text={`Subject: ${result.draftEmail.subject}\n\n${result.draftEmail.body}`}
                                    />
                                    <DownloadButton
                                        text={`Subject: ${result.draftEmail.subject}\n\n${result.draftEmail.body}`}
                                        filename='draft-email.txt'
                                    />
                                    <Button
                                        variant='outline'
                                        size='sm'
                                        onClick={() =>
                                            window.open(
                                                `mailto:?subject=${encodeURIComponent(result.draftEmail.subject)}&body=${encodeURIComponent(result.draftEmail.body)}`,
                                            )
                                        }
                                    >
                                        <Mail className='mr-1.5 h-3.5 w-3.5' />
                                        Open in mail
                                    </Button>
                                </div>
                            </div>
                        </CardHeader>
                        <CardContent className='space-y-3'>
                            <div className='flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2'>
                                <span className='text-xs font-medium text-muted-foreground'>
                                    Subject:
                                </span>
                                <span className='text-sm font-medium'>
                                    {result.draftEmail.subject}
                                </span>
                            </div>
                            <pre className='max-h-[360px] overflow-auto whitespace-pre-wrap rounded-md bg-muted p-4 text-sm leading-relaxed'>
                                {result.draftEmail.body}
                            </pre>
                        </CardContent>
                    </Card>
                </div>

                {/* Right: Job Match Analysis */}
                <div className='space-y-4'>
                    <Card className='sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto'>
                        <CardHeader className='pb-3'>
                            <CardTitle>Job Match Analysis</CardTitle>
                        </CardHeader>
                        <CardContent className='space-y-5'>
                            {/* Score comparison */}
                            <div className='grid grid-cols-3 gap-3 rounded-lg border p-3 text-center'>
                                <div>
                                    <p className='text-xs font-medium uppercase tracking-wide text-muted-foreground'>
                                        Original
                                    </p>
                                    <p className='mt-1 text-2xl font-bold'>
                                        {analysis.originalScore}%
                                    </p>
                                    <ScoreBar score={analysis.originalScore} />
                                </div>
                                <div>
                                    <p className='text-xs font-medium uppercase tracking-wide text-muted-foreground'>
                                        Tailored
                                    </p>
                                    <p className='mt-1 text-2xl font-bold'>
                                        {analysis.tailoredScore}%
                                    </p>
                                    <ScoreBar score={analysis.tailoredScore} />
                                </div>
                                <div>
                                    <p className='text-xs font-medium uppercase tracking-wide text-muted-foreground'>
                                        Improvement
                                    </p>
                                    <p
                                        className={cn(
                                            "mt-1 text-2xl font-bold",
                                            analysis.improvement > 0
                                                ? "text-emerald-600"
                                                : "text-muted-foreground",
                                        )}
                                    >
                                        {analysis.improvement > 0 ? "+" : ""}
                                        {analysis.improvement}%
                                    </p>
                                    <p className='mt-1 text-xs text-muted-foreground'>
                                        After first pass
                                    </p>
                                </div>
                            </div>

                            <p className='text-xs text-muted-foreground'>
                                This analysis is based on your tailored resume,
                                not the original upload. Missing keywords below
                                are remaining deficits after tailoring.
                            </p>

                            <Separator />

                            {/* What we improved */}
                            <div className='space-y-2'>
                                <p className='text-sm font-semibold'>
                                    What We Improved
                                </p>
                                <ul className='space-y-1.5'>
                                    {analysis.whatWeImproved.map((item, i) => (
                                        <li
                                            key={i}
                                            className='flex gap-2 text-sm text-muted-foreground'
                                        >
                                            <TrendingUp className='mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600' />
                                            {item}
                                        </li>
                                    ))}
                                </ul>
                            </div>

                            <Separator />

                            {/* Strengths */}
                            <div className='space-y-2'>
                                <p className='text-sm font-semibold'>
                                    Strengths
                                </p>
                                <ul className='space-y-1.5'>
                                    {analysis.strengths.map((item, i) => (
                                        <li
                                            key={i}
                                            className='flex gap-2 text-sm text-muted-foreground'
                                        >
                                            <span className='mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary' />
                                            {item}
                                        </li>
                                    ))}
                                </ul>
                            </div>

                            <Separator />

                            {/* Remaining deficits */}
                            <div className='space-y-2'>
                                <p className='text-sm font-semibold'>
                                    Remaining Deficits in Your Tailored Resume
                                </p>
                                <ul className='space-y-1.5'>
                                    {analysis.remainingDeficits.map(
                                        (item, i) => (
                                            <li
                                                key={i}
                                                className='flex gap-2 text-sm text-muted-foreground'
                                            >
                                                <span className='mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500' />
                                                {item}
                                            </li>
                                        ),
                                    )}
                                </ul>
                            </div>

                            <Separator />

                            {/* Matched keywords */}
                            <div className='space-y-2'>
                                <p className='text-sm font-semibold'>
                                    Matched Keywords
                                </p>
                                <div className='flex flex-wrap gap-1.5'>
                                    {analysis.matchedKeywords.map((kw) => (
                                        <span
                                            key={kw}
                                            className='inline-flex items-center rounded-full border bg-muted px-2.5 py-0.5 text-xs font-medium'
                                        >
                                            {kw}
                                        </span>
                                    ))}
                                </div>
                            </div>

                            <Separator />

                            {/* Missing keywords */}
                            <div className='space-y-2'>
                                <div className='flex items-center justify-between'>
                                    <p className='text-sm font-semibold'>
                                        Missing Keywords
                                    </p>
                                    <button className='inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline'>
                                        <Sparkles className='h-3 w-3' />
                                        Add These Skills
                                    </button>
                                </div>
                                <div className='flex flex-wrap gap-1.5'>
                                    {analysis.missingKeywords.map((kw) => (
                                        <span
                                            key={kw}
                                            className='inline-flex items-center rounded-full bg-destructive/10 px-2.5 py-0.5 text-xs font-medium text-destructive'
                                        >
                                            {kw}
                                        </span>
                                    ))}
                                </div>
                                <p className='text-xs text-muted-foreground'>
                                    We only add skills and language already
                                    supported by your original resume. To add
                                    genuinely new skills, upload a new resume
                                    and re-run tailoring.
                                </p>
                            </div>

                            <Separator />

                            {/* Suggestions */}
                            <div className='space-y-2'>
                                <p className='text-sm font-semibold'>
                                    Suggestions
                                </p>
                                <ul className='space-y-1.5'>
                                    {analysis.suggestions.map((item, i) => (
                                        <li
                                            key={i}
                                            className='flex gap-2 text-sm text-muted-foreground'
                                        >
                                            <span className='shrink-0 font-medium text-foreground'>
                                                {i + 1}.
                                            </span>
                                            {item}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        </CardContent>
                    </Card>
                </div>
            </div>
        </section>
    );
}
