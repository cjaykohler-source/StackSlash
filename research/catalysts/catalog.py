"""
Human-readable names, one-line descriptions and hand-set verdict overrides
for every catalyst type, published to research_catalyst_types for the web
UI. The default verdict comes from the harness (candidate -> avoid/positive
by sign, tested -> none); OVERRIDES carry results from other studies (the
dilution rules validated on 2022+ in docs/filing-state-study.md) and leads
worth watching that haven't cleared the bar.
"""

LABELS = {
    # EDGAR 8-K items
    "8k_1.01": ("8-K 1.01 material agreement", "Entered a material definitive agreement."),
    "8k_1.02": ("8-K 1.02 agreement terminated", "Termination of a material definitive agreement."),
    "8k_1.03": ("8-K 1.03 bankruptcy", "Bankruptcy or receivership."),
    "8k_2.01": ("8-K 2.01 acquisition/disposition", "Completed an acquisition or disposition of assets."),
    "8k_2.02": ("8-K 2.02 earnings release", "Results of operations — the earnings release."),
    "8k_2.03": ("8-K 2.03 new debt", "Created a direct financial obligation."),
    "8k_2.04": ("8-K 2.04 debt acceleration", "Triggering events that accelerate an obligation."),
    "8k_2.05": ("8-K 2.05 exit/restructuring costs", "Costs associated with exit or disposal activities."),
    "8k_2.06": ("8-K 2.06 impairment", "Material impairments."),
    "8k_3.01": ("8-K 3.01 listing deficiency", "Notice of delisting or failure to meet a listing rule."),
    "8k_3.02": ("8-K 3.02 unregistered share sale", "Unregistered sale of equity securities — a dilution event."),
    "8k_3.03": ("8-K 3.03 holder-rights change", "Material modification of security holders' rights (often a reverse split)."),
    "8k_4.01": ("8-K 4.01 auditor change", "Change in the certifying accountant."),
    "8k_4.02": ("8-K 4.02 non-reliance", "Previously issued financials should no longer be relied on."),
    "8k_5.01": ("8-K 5.01 change in control", "Change in control of the registrant."),
    "8k_5.02": ("8-K 5.02 officer/director change", "Departure or appointment of directors or officers."),
    "8k_5.03": ("8-K 5.03 charter/bylaw change", "Amendments to articles or bylaws (often a reverse split)."),
    "8k_5.07": ("8-K 5.07 shareholder vote", "Results of a shareholder vote."),
    "8k_7.01": ("8-K 7.01 Reg FD", "Regulation FD disclosure (investor decks, PR)."),
    "8k_8.01": ("8-K 8.01 other events", "Other events the company chose to report."),
    # EDGAR forms
    "13d_new": ("13D new (activist 5%+)", "New >5% holder with intent to influence."),
    "13d_amend": ("13D amendment", "Amended activist filing."),
    "13g_new": ("13G new (passive 5%+)", "New passive >5% holder."),
    "13g_amend": ("13G amendment", "Amended passive-holder filing."),
    "form4": ("Form 4 (any)", "Any insider transaction report — see the f4_* types for buys vs sells."),
    "form144": ("Form 144 planned sale", "Notice of a proposed sale of restricted stock."),
    "s1": ("S-1/F-1 registration", "Registration statement — a share offering is being prepared."),
    "s3": ("S-3/F-3 shelf registration", "Shelf registration — the company can sell shares at will."),
    "s8": ("S-8 employee plan shares", "Shares registered for employee plans."),
    "424b3": ("424B3 prospectus", "Prospectus supplement (resale registrations, ATMs)."),
    "424b4": ("424B4 priced offering", "Final prospectus for a priced offering."),
    "424b5": ("424B5 priced offering", "Prospectus supplement for a shelf takedown."),
    "nt_late_filing": ("NT 10-Q/10-K late filing", "Notice that a periodic report will be late."),
    "10q": ("10-Q filed", "Quarterly report filed."),
    "10k": ("10-K filed", "Annual report filed."),
    "proxy_pre": ("Preliminary proxy", "PRE 14A — often a vote on a reverse split or share authorisation."),
    "proxy_def": ("Definitive proxy", "DEF 14A."),
    "info_stmt_pre": ("Preliminary information statement", "PRE 14C — action by written consent."),
    "merger_425": ("Merger communication (425)", "Business-combination communications."),
    "tender_offer": ("Tender offer (SC TO-T)", "Third-party tender offer."),
    "tender_response": ("Tender response (SC 14D9)", "Company's response to a tender offer."),
    "delisting_25": ("Form 25 delisting", "Exchange notice of removal from listing."),
    "deregistration": ("Form 15 deregistration", "Suspension of SEC reporting."),
    "registration_effective": ("Registration effective", "SEC declared a registration effective."),
    # corporate actions
    "ca_reverse_splits": ("Reverse split (ex-date)", "Reverse split took effect."),
    "ca_forward_splits": ("Forward split (ex-date)", "Forward split took effect."),
    "ca_cash_dividends": ("Cash dividend (ex-date)", "Returns are price-only, so never flagged."),
    "ca_stock_dividends": ("Stock dividend", "Stock dividend ex-date."),
    "ca_spin_offs": ("Spin-off", "Spin-off ex-date."),
    "ca_capital_gains_distributions": ("Capital-gains distribution", "Fund distribution."),
    "ca_rights_distributions": ("Rights distribution", "Rights offering distribution."),
    # earnings
    "earn_beat": ("Earnings beat", "Reported EPS above the consensus estimate."),
    "earn_miss": ("Earnings miss", "Reported EPS below the consensus estimate."),
    "earn_inline": ("Earnings in line", "Reported EPS equal to the estimate."),
    "earn_big_beat": ("Earnings big beat", "Surprise >= +25% of max(|estimate|, $0.02)."),
    "earn_big_miss": ("Earnings big miss", "Surprise <= -25% of max(|estimate|, $0.02)."),
    "earn_turn_profitable": ("Turned profitable", "Positive EPS against a negative estimate."),
    # going concern
    "gc_10k": ("Going concern (10-K)", "Annual report contains going-concern doubt language."),
    "gc_10q": ("Going concern (10-Q)", "Quarterly report contains going-concern doubt language."),
    # form 4
    "f4_buy": ("Insider open-market buy", "Form 4 code P by any insider."),
    "f4_buy_officer": ("Officer buy", "Open-market buy by an officer."),
    "f4_buy_director": ("Director buy", "Open-market buy by a non-officer director."),
    "f4_buy_ten_pct": ("10% holder buy", "Open-market buy by a 10%+ holder."),
    "f4_buy_large": ("Large insider buy ($100k+)", "Open-market buys totalling $100k+ in one filing day."),
    "f4_buy_cluster": ("Cluster insider buying", ">= 2 distinct insiders buying within 14 days."),
    "f4_sell": ("Insider sale", "Form 4 code S by any insider."),
    "f4_sell_officer": ("Officer sale", "Open-market sale by an officer."),
    "f4_sell_large": ("Large insider sale ($250k+)", "Open-market sales totalling $250k+ in one filing day."),
}
NEWS_LABELS = {
    "news_any": "Any headline", "news_fda_approval": "FDA approval", "news_fda_setback": "FDA setback (CRL, hold)",
    "news_trial_positive": "Positive trial data", "news_trial_negative": "Failed trial", "news_contract": "Contract / order",
    "news_partnership": "Partnership / licensing PR", "news_acquired": "To be acquired", "news_offering": "Offering headline",
    "news_upgrade": "Analyst upgrade", "news_downgrade": "Analyst downgrade", "news_initiate": "Coverage initiated",
    "news_pt_raise": "Price-target raise", "news_pt_cut": "Price-target cut", "news_guidance_raise": "Guidance raised",
    "news_guidance_cut": "Guidance cut", "news_buyback": "Buyback", "news_listing_deficiency": "Listing deficiency notice",
    "news_reverse_split": "Reverse split headline", "news_uplisting": "Uplisting", "news_bankruptcy": "Bankruptcy headline",
    "news_investigation": "Investigation / class action", "news_short_report": "Short-seller report", "news_halt": "Trading halt",
    "news_patent": "Patent", "news_insider_buy": "Insider buy headline",
}
for k, v in NEWS_LABELS.items():
    LABELS[k] = (v, "Benzinga headline (Alpaca news), regex-classified.")

OVERRIDES = {
    "s1": ("avoid", "Dilution rule validated on 2022+ (docs/filing-state-study.md): -11.3% over 60 sessions."),
    "s3": ("avoid", "Dilution rule validated on 2022+: registration in the last 30 days."),
    "424b4": ("avoid", "Dilution rule validated on 2022+: priced offering, -9.4% over 60 sessions."),
    "424b5": ("avoid", "Dilution rule validated on 2022+: priced offering, -9.4% over 60 sessions."),
    # the pre-registered 2022+ holdout (docs/catalyst-2022-prereg.md, run 20261001T092244)
    "news_halt": ("avoid", "Validated on 2022+ (pre-registered): -9.5% vs the same names at random dates over 20 sessions, -9.7% in the $0.10-$5 band."),
    "news_partnership": ("avoid", "Validated on 2022+ (pre-registered): -1.6% vs random dates over 20 sessions, -2.2% in the $0.10-$5 band."),
    "10k": ("watch", "Passed 2022+ (-1.0%, Holm p 0.001) but not clear of random dates in the $0.10-$5 band."),
    "earn_beat": ("none", "Failed out of sample: +0.34% vs random dates on 2022+, p 0.10 (pre-registered)."),
    "8k_2.02": ("none", "Failed out of sample: -0.19% vs random dates on 2022+ (pre-registered, secondary)."),
    "10q": ("none", "Failed out of sample: +0.07% vs random dates on 2022+ (pre-registered, secondary)."),
    "earn_big_beat": ("watch", "+1.2% on 2022+, p 0.001 — but a secondary subset of the failed earnings-beat rule; needs its own pre-registered test."),
    "gc_10k": ("watch", "Worst 10-Ks in 2016-21 (-2.8%); -1.0% on 2022+, p 0.18 (secondary) — not clear of the bar."),
    "8k_3.02": ("watch", "Dilution family, -1.3%, q 0.19 — consistent with the validated rule."),
    "news_insider_buy": ("watch", "+3.0%, q 0.12 on 379 events — see the Form 4 types for the full sample."),
    "news_pt_cut": ("watch", "Passes 2016-21 but unexplained and flips sign in the $0.10-$5 band; deliberately not tested on 2022+."),
    "ca_cash_dividends": ("none", "Price-only returns bias dividend events; never judged."),
}
