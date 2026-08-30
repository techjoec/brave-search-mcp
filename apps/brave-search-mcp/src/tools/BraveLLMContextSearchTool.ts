import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { BraveSearch, ContextThresholdMode } from 'brave-search';
import type { LlmContextConfig } from '../config-loader.js';
import type { ToolInterceptor, ToolLogger } from './tool-helpers.js';
import { z } from 'zod';
import { DEFAULT_LLM_CONTEXT_CONFIG } from '../config-loader.js';
import { TOOL_NAMES } from '../tool-catalog.js';
import { buildToolErrorResult, executeTool, justificationInputSchema } from './tool-helpers.js';

const COMPACT_CONTEXT_THRESHOLD_MODE = 'balanced' as ContextThresholdMode;

const boilerplateSignals = [
  'table of contents',
  'related posts',
  'related videos',
  'recommended video',
  'share on facebook',
  'tweet on twitter',
  'pin on pinterest',
  'terms and privacy policy',
  'privacy policy',
  'home »',
  'sources:',
];

function createLlmContextSearchInputSchema(defaults: LlmContextConfig) {
  return z.object({
    query: z.string().max(400).describe('The search query. Maximum 400 characters and 50 words.'),
    url: z.url().optional().describe('Optional URL to target. When provided, the tool retrieves context for that URL and only returns snippets from that exact URL.'),
    count: z.number().min(1).max(50).default(defaults.count).optional().describe(`The maximum number of search results considered. Default ${defaults.count}.`),
    maximumNumberOfUrls: z.number().min(1).max(50).default(defaults.maximumNumberOfUrls).optional().describe(`The maximum number of URLs to include. Default ${defaults.maximumNumberOfUrls}.`),
    maximumNumberOfTokens: z.number().min(1024).max(32768).default(defaults.maximumNumberOfTokens).optional().describe(`Approximate total token limit. Default ${defaults.maximumNumberOfTokens}.`),
    maximumNumberOfSnippets: z.number().min(1).max(100).default(defaults.maximumNumberOfSnippets).optional().describe(`Maximum snippets across all URLs. Default ${defaults.maximumNumberOfSnippets}.`),
    maximumNumberOfTokensPerUrl: z.number().min(512).max(8192).default(defaults.maximumNumberOfTokensPerUrl).optional().describe(`Maximum tokens per URL. Default ${defaults.maximumNumberOfTokensPerUrl}.`),
    maximumNumberOfSnippetsPerUrl: z.number().min(1).max(100).default(defaults.maximumNumberOfSnippetsPerUrl).optional().describe(`Maximum snippets per URL. Default ${defaults.maximumNumberOfSnippetsPerUrl}.`),
    responseMode: z.enum(['compact', 'full']).default(defaults.responseMode).optional().describe('compact applies Brave\'s balanced relevance filtering plus local snippet filtering/truncation. full disables Brave\'s relevance filtering and returns raw snippets without local filtering or truncation.'),
    maxSnippetChars: z.number().int().min(80).max(4000).default(defaults.maxSnippetChars).optional().describe(`Maximum characters per snippet in compact mode. Default ${defaults.maxSnippetChars}.`),
    maxOutputChars: z.number().int().min(1000).max(100000).default(defaults.maxOutputChars).optional().describe(`Approximate maximum serialized response size in compact mode. Default ${defaults.maxOutputChars}.`),
    justification: justificationInputSchema,
  });
}

export type BraveLLMContextSearchInput = z.infer<ReturnType<typeof createLlmContextSearchInputSchema>>;

export class BraveLLMContextSearchTool {
  public readonly name = TOOL_NAMES.llmContext;
  public readonly description = 'Best for questions that require reading and synthesizing web page content, '
    + 'such as "how does X work", "explain Y in detail", or "what are the tradeoffs of Z". '
    + 'Returns extracted text from web pages rather than just titles and descriptions. '
    + 'Also useful for extracting text from a specific URL. '
    + `Not needed for simple factual lookups — use ${TOOL_NAMES.web} for those.`;

  public readonly inputSchema;

  constructor(
    private logMessage: ToolLogger,
    private braveSearch: BraveSearch,
    private isUI: boolean = false,
    private interceptors: readonly ToolInterceptor[] = [],
    private defaults: LlmContextConfig = { ...DEFAULT_LLM_CONTEXT_CONFIG },
  ) {
    this.inputSchema = createLlmContextSearchInputSchema(defaults);
  }

  public async execute(input: BraveLLMContextSearchInput): Promise<CallToolResult> {
    return executeTool({
      toolName: this.name,
      input,
      executeCore: value => this.executeCore(value),
      buildErrorResult: (_value, error) => buildToolErrorResult(this.name, error),
      interceptors: this.interceptors,
    });
  }

  private buildNoContextResult(query: string, url?: string): CallToolResult {
    if (url) {
      this.logMessage(`No LLM context snippets found for URL "${url}" with query "${query}"`, 'info');
      return {
        content: [{ type: 'text', text: `No context snippets found for URL "${url}" with query "${query}"` }],
      };
    }

    this.logMessage(`No LLM context results found for "${query}"`, 'info');
    return {
      content: [{ type: 'text', text: `No context results found for "${query}"` }],
    };
  }

  public async executeCore(input: BraveLLMContextSearchInput): Promise<CallToolResult> {
    const {
      query,
      url,
      count,
      maximumNumberOfUrls,
      maximumNumberOfTokens,
      maximumNumberOfSnippets,
      maximumNumberOfTokensPerUrl,
      maximumNumberOfSnippetsPerUrl,
      responseMode,
      maxSnippetChars,
      maxOutputChars,
    } = input;

    const isCompact = (responseMode ?? this.defaults.responseMode) !== 'full';
    const effectiveCount = isCompact ? Math.min(count ?? this.defaults.count, this.defaults.count) : count ?? this.defaults.count;
    const effectiveMaximumNumberOfUrls = isCompact
      ? Math.min(maximumNumberOfUrls ?? this.defaults.maximumNumberOfUrls, this.defaults.maximumNumberOfUrls)
      : maximumNumberOfUrls ?? this.defaults.maximumNumberOfUrls;
    const effectiveMaximumNumberOfTokens = isCompact
      ? Math.min(maximumNumberOfTokens ?? this.defaults.maximumNumberOfTokens, this.defaults.maximumNumberOfTokens)
      : maximumNumberOfTokens ?? this.defaults.maximumNumberOfTokens;
    const effectiveMaximumNumberOfSnippets = isCompact
      ? Math.min(maximumNumberOfSnippets ?? this.defaults.maximumNumberOfSnippets, this.defaults.maximumNumberOfSnippets)
      : maximumNumberOfSnippets ?? this.defaults.maximumNumberOfSnippets;
    const effectiveMaximumNumberOfTokensPerUrl = isCompact
      ? Math.min(maximumNumberOfTokensPerUrl ?? this.defaults.maximumNumberOfTokensPerUrl, this.defaults.maximumNumberOfTokensPerUrl)
      : maximumNumberOfTokensPerUrl ?? this.defaults.maximumNumberOfTokensPerUrl;
    const effectiveMaximumNumberOfSnippetsPerUrl = isCompact
      ? Math.min(maximumNumberOfSnippetsPerUrl ?? this.defaults.maximumNumberOfSnippetsPerUrl, this.defaults.maximumNumberOfSnippetsPerUrl)
      : maximumNumberOfSnippetsPerUrl ?? this.defaults.maximumNumberOfSnippetsPerUrl;
    const retrievalQuery = url ?? query;

    const results = await this.braveSearch.llmContextSearch(retrievalQuery, {
      count: effectiveCount,
      maximum_number_of_urls: effectiveMaximumNumberOfUrls,
      maximum_number_of_tokens: effectiveMaximumNumberOfTokens,
      maximum_number_of_snippets: effectiveMaximumNumberOfSnippets,
      maximum_number_of_tokens_per_url: effectiveMaximumNumberOfTokensPerUrl,
      maximum_number_of_snippets_per_url: effectiveMaximumNumberOfSnippetsPerUrl,
      context_threshold_mode: isCompact ? COMPACT_CONTEXT_THRESHOLD_MODE : 'disabled',
    });

    const genericItems = url
      ? (results.grounding?.generic ?? []).filter(item => item.url === url)
      : results.grounding?.generic ?? [];

    if (genericItems.length === 0)
      return this.buildNoContextResult(query, url);

    if (!isCompact) {
      const contentText = genericItems
        .map((item) => {
          const source = results.sources?.[item.url];
          const age = source?.age?.[0];
          const snippets = item.snippets.map((s) => {
            const trimmed = s.trim();
            try {
              return JSON.parse(trimmed);
            }
            catch {
              return trimmed;
            }
          });
          return JSON.stringify({ title: item.title, url: item.url, ...(age && { age }), snippets });
        })
        .join('\n');

      return {
        content: [{ type: 'text', text: contentText }],
      };
    }

    const outputLimit = maxOutputChars ?? this.defaults.maxOutputChars;
    const snippetCharLimit = maxSnippetChars ?? this.defaults.maxSnippetChars;
    const queryTerms = this.extractQueryTerms(query);
    const compactLines: string[] = [];
    let outputChars = 0;
    let totalSnippetCount = 0;
    const globalSnippetLimit = effectiveMaximumNumberOfSnippets ?? this.defaults.maximumNumberOfSnippets;
    const perUrlSnippetLimit = effectiveMaximumNumberOfSnippetsPerUrl ?? this.defaults.maximumNumberOfSnippetsPerUrl;

    for (const item of genericItems) {
      if (totalSnippetCount >= globalSnippetLimit)
        break;

      const source = results.sources?.[item.url];
      const age = source?.age?.[0];
      const cleanedSnippets = this.compactSnippets(item.snippets, queryTerms, snippetCharLimit, perUrlSnippetLimit);
      if (cleanedSnippets.length === 0)
        continue;

      const allowedSnippetCount = Math.max(globalSnippetLimit - totalSnippetCount, 0);
      const lineSnippets: string[] = [];
      for (const snippet of cleanedSnippets.slice(0, allowedSnippetCount)) {
        const candidateLine = JSON.stringify({
          title: item.title,
          url: item.url,
          ...(age ? { age } : {}),
          snippets: [...lineSnippets, snippet],
        });
        const delimiterLength = compactLines.length > 0 ? 1 : 0;
        if (outputChars + delimiterLength + candidateLine.length > outputLimit)
          break;
        lineSnippets.push(snippet);
      }

      if (lineSnippets.length === 0)
        break;

      const line = JSON.stringify({
        title: item.title,
        url: item.url,
        ...(age ? { age } : {}),
        snippets: lineSnippets,
      });
      const delimiterLength = compactLines.length > 0 ? 1 : 0;
      if (outputChars + delimiterLength + line.length > outputLimit)
        break;

      compactLines.push(line);
      outputChars += delimiterLength + line.length;
      totalSnippetCount += lineSnippets.length;
    }

    if (compactLines.length === 0)
      return this.buildNoContextResult(query, url);

    const contentText = compactLines.join('\n');

    return {
      content: [{ type: 'text', text: contentText }],
    };
  }

  private compactSnippets(
    rawSnippets: string[],
    queryTerms: string[],
    maxSnippetChars: number,
    maxPerUrl: number,
  ): string[] {
    const normalizedSeen = new Set<string>();
    const candidates: Array<{ value: string; score: number }> = [];

    for (const rawSnippet of rawSnippets) {
      const sanitized = this.sanitizeSnippet(rawSnippet);
      if (!sanitized)
        continue;
      if (this.isLikelyStructuredData(sanitized))
        continue;
      if (this.isLikelyBoilerplate(sanitized))
        continue;

      const normalized = this.normalizeSnippet(sanitized);
      if (!normalized || normalizedSeen.has(normalized))
        continue;
      normalizedSeen.add(normalized);

      candidates.push({
        value: this.truncateSnippet(sanitized, maxSnippetChars),
        score: this.scoreSnippet(sanitized, queryTerms),
      });
    }

    candidates.sort((a, b) => {
      if (b.score !== a.score)
        return b.score - a.score;
      return b.value.length - a.value.length;
    });

    const selected: string[] = [];
    for (const candidate of candidates) {
      if (selected.some(existing => this.areNearDuplicates(existing, candidate.value)))
        continue;
      selected.push(candidate.value);
      if (selected.length >= maxPerUrl)
        break;
    }

    return selected;
  }

  private sanitizeSnippet(snippet: string): string {
    return snippet
      .trim()
      .replace(/\*\[Image:[^\]]*\]\*/gi, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private isLikelyStructuredData(snippet: string): boolean {
    const trimmed = snippet.trim();
    const lower = trimmed.toLowerCase();
    if (lower.includes('"@graph"') || lower.includes('"@context"') || lower.includes('"@type"'))
      return true;
    if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length > 160)
      return true;
    return false;
  }

  private isLikelyBoilerplate(snippet: string): boolean {
    const lower = snippet.toLowerCase();
    return boilerplateSignals.some(signal => lower.includes(signal));
  }

  private extractQueryTerms(query: string): string[] {
    return [...new Set(query
      .toLowerCase()
      .split(/\W+/)
      .map(s => s.trim())
      .filter(s => s.length >= 3))];
  }

  private scoreSnippet(snippet: string, queryTerms: string[]): number {
    const lower = snippet.toLowerCase();
    const overlap = queryTerms.reduce((score, term) => score + (lower.includes(term) ? 1 : 0), 0);
    const lengthBonus = Math.min(snippet.length, 300) / 1000;
    return overlap + lengthBonus;
  }

  private normalizeSnippet(snippet: string): string {
    return snippet
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private areNearDuplicates(a: string, b: string): boolean {
    const left = this.normalizeSnippet(a);
    const right = this.normalizeSnippet(b);
    if (!left || !right)
      return false;
    if (left === right)
      return true;
    if (Math.min(left.length, right.length) < 80)
      return false;
    return left.includes(right) || right.includes(left);
  }

  private truncateSnippet(snippet: string, maxSnippetChars: number): string {
    if (snippet.length <= maxSnippetChars)
      return snippet;
    return `${snippet.slice(0, maxSnippetChars - 3).trimEnd()}...`;
  }
}
