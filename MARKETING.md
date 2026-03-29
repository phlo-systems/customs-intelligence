# Marketing Setup — customs-compliance.ai

## Domain & Deployment
- **Domain:** customs-compliance.ai
- **Hosting:** Vercel — `vercel --prod` → aliased to customs-compliance.ai
- **App URL:** https://customs-compliance.ai/app
- **Landing page:** https://customs-compliance.ai/

## SEO Pages (deployed)
- **50 product duty pages** — e.g., `/duty/cocoa-beans-hs-1801`
- **28 trade route pages** — e.g., `/duty/route/india-to-united-kingdom`
- **5 tool landing pages** — calculator, landed cost, HS lookup, FTA finder, documents checker
- **Sitemap:** https://customs-compliance.ai/sitemap.xml (86 URLs)

## Search Engine Registration

### Google Search Console — DONE (29 Mar 2026)
- Property: https://customs-compliance.ai (URL prefix)
- Verification: HTML file (`googleb46e5193aa70bb65.html` in `ui/`)
- Vercel route added in `vercel.json` for the verification file
- Canonical tag added to `landing.html`: `<link rel="canonical" href="https://customs-compliance.ai/">`
- Sitemap submitted: 86 URLs discovered
- Indexing requested for homepage

### Bing Webmaster Tools — DONE (29 Mar 2026)
- Imported from Google Search Console (auto-verified)
- Sitemap: 86 URLs discovered, status **Success**
- Also feeds Yahoo and DuckDuckGo results

## AI Search Engine Discoverability

### Files deployed
| File | URL | Purpose |
|------|-----|---------|
| `robots.txt` | https://customs-compliance.ai/robots.txt | Allows GPTBot, ChatGPT-User, Claude-Web, Anthropic-AI, PerplexityBot, Google-Extended |
| `llms.txt` | https://customs-compliance.ai/llms.txt | Summary for AI models |
| `llms-full.txt` | https://customs-compliance.ai/llms-full.txt | Full duty rate data (50 products, 8 countries) |

### OpenAI / ChatGPT — DONE
- No publisher registration needed — access is controlled via `robots.txt`
- `robots.txt` allows `GPTBot` and `ChatGPT-User`

### Perplexity — TODO
- Email publishers@perplexity.ai requesting priority crawling
- Draft email:
  > Subject: Priority crawling request — customs-compliance.ai (customs duty database, 18 countries)
  >
  > Hi, we'd like to request priority crawling for customs-compliance.ai — a customs duty rate database covering 18 countries with 153K+ tariff codes, including MFN rates, FTA preferential rates, VAT/GST, anti-dumping duties, and landed cost calculations. We have llms.txt deployed at https://customs-compliance.ai/llms.txt and full structured data at https://customs-compliance.ai/llms-full.txt. Our robots.txt explicitly allows PerplexityBot. Thank you, Saurabh Goyal, Phlo Systems Limited

### Google Gemini
- `robots.txt` allows `Google-Extended` (Google's AI crawler)
- Being in Google Search Console makes site eligible for Gemini citations

## Social Media

### LinkedIn — DONE (29 Mar 2026)
- Posted from existing **Phlo Systems Ltd.** company page (4,748 followers)
- First post published with verified duty rate examples:
  - Motor vehicles (HS 8703): 70% BCD into India, 5% into Australia, 10% into UK
  - Wine (HS 2204): 100% into India, 0% into UK from South Africa (SADC EPA)
  - Smartphones (HS 8517): 15% BCD + 18% IGST into India, 0% into UK

### LinkedIn post drafts (for weekly cadence)
**Post 2:**
> Are you leaving FTA savings on the table?
>
> Many importers pay full MFN duty rates when a preferential rate exists under a free trade agreement. Example: importing flat-rolled steel (HS 7210) into South Africa from the UK — MFN rate is 10%, but under the SACU-EPA it drops to 0%.
>
> Check your routes for savings: customs-compliance.ai/tools/fta-savings-finder
>
> #FTA #TradeAgreements #CustomsCompliance #LandedCost

### Reddit — TODO (space posts 1 per day)

**Post 1 — r/importexport:**
> Title: Import duty rates across 18 countries — free lookup tool
>
> We built a customs duty database that covers MFN rates, FTA preferential rates, VAT/GST, and anti-dumping duties for 18 countries (India, UK, South Africa, Brazil, Australia, Mexico, Thailand, UAE, Saudi Arabia, and more).
>
> Some interesting findings from the data:
> - Motor vehicles (HS 8703): India charges 70% BCD, Australia just 5%, UK 10%
> - Cocoa beans (HS 1801): 0% into the UK, 30% into India, 0% into South Africa under SADC-FTA
> - Smartphones (HS 8517): 15% BCD into India (with 18% IGST on top), 0% into UK
>
> You can look up any product across all 18 countries here: customs-compliance.ai/duty/
>
> Happy to answer questions about specific HS codes or trade routes.

**Post 2 — r/ecommerce:**
> Title: How to check import duties before sourcing internationally
>
> If you're sourcing products from overseas, duty rates can make or break your margins. A few examples that catch people off guard:
> - Importing clothing (HS 6109) into India: 20% BCD + 5% GST
> - Wine (HS 2204) into India: 100% basic duty
> - The same wine into UK: 0% if from South Africa (EPA trade agreement)
>
> We've put together a free tool that shows duty rates for 50 common products across 18 countries, including FTA savings: customs-compliance.ai/duty/
>
> Also has a landed cost calculator if you want to estimate total import cost including duties + taxes: customs-compliance.ai/tools/landed-cost-calculator

**Post 3 — r/supplychain:**
> Title: FTA savings most importers are missing
>
> We analysed preferential trade agreements across 18 countries and the savings are significant:
> - South Africa to UK (SACU-EPA): most agricultural products drop from 8-20% MFN to 0%
> - India to UAE (CEPA): many textiles and chemicals get 0-5% preferential vs 5-15% MFN
> - Chile to UK: wine at 0% preferential vs 32p/litre MFN
>
> Most importers just pay MFN because they don't know a preferential rate exists for their route. We built a free FTA savings finder: customs-compliance.ai/tools/fta-savings-finder
>
> What trade routes are you running? Happy to check if there's a preference available.

## Key URLs Reference
| URL | Purpose |
|-----|---------|
| https://customs-compliance.ai/ | Landing page |
| https://customs-compliance.ai/app | Main application |
| https://customs-compliance.ai/sitemap.xml | Sitemap (86 URLs) |
| https://customs-compliance.ai/robots.txt | Crawler permissions |
| https://customs-compliance.ai/llms.txt | AI model summary |
| https://customs-compliance.ai/llms-full.txt | Full AI data reference |
| https://customs-compliance.ai/duty/ | Product duty index (50 goods) |
| https://customs-compliance.ai/duty/cocoa-beans-hs-1801 | Example product page |
| https://customs-compliance.ai/duty/route/india-to-united-kingdom | Example route page |
| https://customs-compliance.ai/tools/customs-duty-calculator | Tool landing page |
| https://customs-compliance.ai/tools/landed-cost-calculator | Tool landing page |
| https://customs-compliance.ai/tools/hs-code-lookup | Tool landing page |
| https://customs-compliance.ai/tools/fta-savings-finder | Tool landing page |
| https://customs-compliance.ai/tools/import-documents-checker | Tool landing page |

## Expected Timelines
- Google indexing: 3-7 days for homepage, 2-4 weeks for all 86 pages
- Bing: 1-2 weeks
- AI models (ChatGPT/Claude/Perplexity): 2-8 weeks depending on crawl cycles
- Reddit/content seeding: immediate traffic, AI pickup within 1-2 months

## Rate Verification Note (29 Mar 2026)
Before posting, all duty rates were verified against the live database AND cross-checked via internet search. Three India rates were found outdated and corrected:
- Motor vehicles (HS 8703): 125% → 70% (Budget 2025, Feb 2025)
- Wine (HS 2204): 150% → 100% (CBIC Notification 14/2025, Feb 2025)
- Smartphones (HS 8517): 20% → 15% (Budget 2024, Jul 2024)

This gap led to the design of the **Universal Tariff Updater Framework** (9-point checklist) to prevent future misses.
