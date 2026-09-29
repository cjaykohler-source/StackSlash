import json,glob,collections,csv,os
HERE=os.path.dirname(os.path.abspath(__file__))
ROOT=os.path.dirname(HERE)
G={
"Follow the Trend / Trade With the Trend":["Trend Following","Trend-Following Systems","Avoid Trading Against the Prevailing Trend","Trade What the Market Is Doing, Not Your Forecast"],
"Always Use a Stop-Loss":["Risk Management and Stop-Loss Discipline","Use Protective Stop Loss for Risk Management","Stop Loss Discipline","Place Stop Loss Orders Carefully","Adjust Stop-Loss and Profit Targets to Market Volatility (ATR)"],
"Control Emotions: Avoid Fear and Greed":["Trading Psychology and Emotion Control","Automate Trading to Remove Emotion","Psycho-Cybernetics Mental Preparation","Visualization Techniques for Trading Success"],
"Momentum Indicators (RSI, MACD, Stochastics)":["RSI (Relative Strength Index)","Momentum Indicators and Oscillators","MACD (Moving Average Convergence Divergence)","Stochastics Indicator","Momentum Trading"],
"Follow Your Trading Plan/System Without Deviation":["Plan the Trade, Trade the Plan","Trading Discipline and System Adherence","Established Trading Rules Framework","Flawless Execution of Trading Signals","Treat Trading As a Business With a Written Plan"],
"Cut Losses Short, Let Winners Run":["Cut Losses Short","Let Winners Run"],
"Use Moving Averages to Identify Trend":["Moving Averages","Moving Average Crossover Method","Exponential Moving Average (EMA) Crossover System","Pullback Entry Strategy Using EMAs","Initial Aggressive Entry Above 72 EMA","Perfect Order Strategy"],
"Position Sizing Based on Risk":["Trading Systems Approach vs Money Management School","Position Sizing and Capital Preservation","Position Sizing","Money Management Trading Strategy","Match Money Management Strategy to Trader's Risk Tolerance and Capitalization","Increase Position Size Gradually After Proven Success, Reduce After Losses","Limit Total Portfolio Risk Across All Open Positions","Don't Place All Your Equity in Any Single Position"],
"Breakout Trading Above Resistance/Below Support":["Breakout Strategy","Inside Day Breakout Play","Breakout Target Calculation","Filtering False Breakouts","Beware of Stop-Running by Market Insiders / False Breakouts","Channel Strategy"],
"Have a Predefined Exit Plan Before Entering":["Predefined Exit Plans","Develop Exit Strategy (Trailing Stops, Signals)","Exit Signals for Profit Taking","Plan Re-Entry Strategy After Stop Out"],
"Continuous Education and Self-Improvement":["Deliberate Practice and Mentorship Build Trading Skill","Develop Trading Intuition Through Experience","Do Your Homework","Walk Before You Run","Forex Education and Seminar Strategies","Beware of the Dangers of Manual/Undisciplined Forex Trading Without Education"],
"Avoid Overleveraging / Excessive Margin":["Leverage Trading"],
"Backtest a Trading System Before Using Real Money":["System Backtesting and Validation","Test Signals Historically Before Implementation","Signal Selection and Testing Methodology","Mechanical Trading Systems Development","Trading System Design","Evaluate Maximum Drawdown Before Trading a System"],
"Chart Patterns (Head and Shoulders, Triangles, Flags)":["Chart Pattern Trading","Pattern Recognition","Use Precisely Defined Chart Patterns Rather Than Subjective Ones","Wolfe Wave Pattern for Price Reversals","Wolfe Waves","Point-and-Figure Charts","Trend Channel Trading for Reversals and Targets","Andrews' Pitchfork Channel Analysis","Andrews Price Objectives","Congestion Range Trading"],
"Liquidity Matters When Entering/Exiting Positions":["Market Microstructure Analysis","Selling Pressure Analysis","Trade Liquid Markets for Better Execution and Lower Slippage","Liquidity Analysis"],
"Fibonacci Retracement Levels":["Fibonacci Retracements and Ratios","Fibonacci Analysis for Forex","Fibonacci Retracements"],
"Volume Confirms Price Action":["Accumulation Strategy","Distribution Strategy","Volume Analysis","Trading Volume Analysis by Trade Size"],
"Markets Are Cyclical (Bull and Bear Cycles)":["Markets Move in Repeating Cycles (e.g., 3-Day Cycle)","Market Patterns Repeat Due to Human Psychology","Monitor Leading Economic Indicators to Anticipate Business Cycle Turns"],
"Never Risk More Than 1-2% of Capital Per Trade":[],
"Keep a Trading Journal":["Trading Journaling and Record Keeping"],
"Keep Trading Systems Simple":["There Is No Holy Grail Indicator; Consistency and Risk Control Matter Most"],
"Candlestick Patterns Signal Reversals/Continuations":["Candlestick Pattern Recognition","Candlestick Patterns","Forex Trading with Candlestick Patterns","Doji Candlestick Pattern Recognition","Hammer and Hanging Man Patterns","Engulfing Patterns (Bullish and Bearish)","Morning Star and Evening Star Patterns","Harami and Harami Cross Patterns","Belt Hold Lines (Bullish and Bearish)","Piercing Pattern for Bottom Reversals","Tweezers Top and Bottom Reversal Signals","Inverted Hammer Bullish Reversal Signal","Reversal Bar Patterns","Gimmee Bar Strategy"],
"Use Multiple Timeframes for Confirmation":["Multiple Timeframe Analysis","Use Different Chart Intervals for Analysis"],
"Hedge Positions With Options/Futures":["Protective Put Strategy","Married Put Strategy","Collar Option Strategy","Equity Hedge","Use Spread Trades to Reduce Risk"],
"Long-Term Investing Beats Market Timing":["Don't Try to Time the Market Perfectly","Maintain Perspective Over the Long Term Rather Than Short-Term Results","Don't Try to Pick Precise Tops and Bottoms","Efficient Markets Are Difficult to Consistently Beat"],
"Preserve Capital First, Profit Second":["Only Invest Money You Can Afford to Lose","Only Trade Risk Capital You Can Afford to Lose","Trade Only With Risk Capital You Can Afford to Lose","Risk Minimization","Money Management Matters More Than Entry Signal Accuracy"],
"Don't Let Ego Affect Trading Decisions":["Take Full Responsibility for Your Own Trades","Remain Flexible and Don't Marry a Trade"],
"Contrarian Investing: Be Fearful When Others Are Greedy":["Contrarian Indicators","Don't Follow the Crowd","Beware of Speculative Manias and Bubbles"],
"Diversify Across Uncorrelated Assets":["Portfolio Diversification with Low Correlation","Risk and Correlation Analysis","Diversify Internationally Across Geographic Markets","Apply Markowitz Efficient Portfolio Theory"],
"Diversify Across Asset Classes":["Asset Allocation Matters More Than Security Selection","Rebalance Portfolio Periodically","Rebalance Portfolio Periodically to Maintain Asset Allocation"],
"Accept Losses as a Cost of Doing Business":["Being an Active Winner and Loser"],
"Adapt Strategy to Market Conditions":["Trade Systems That Work In All Market Conditions","Define Market Filter Before Trading"],
"Analyze Financial Statements Before Investing":["Fundamental Analysis","Fundamental Analysis and Technical Analysis","Research Thoroughly Before Investing, Not After"],
"Buy Low, Sell High (Value Investing)":["Value Investing","Buy Low/Sell High Strategy","Don't Buy a Stock Just Because It's Cheap (Price ≠ Value)","Buy the Dips"],
"Avoid Overtrading":["Don't Trade Too Many Markets","Follow a Focused Watchlist, Not Too Many Stocks","Take an Occasional Break from the Markets"],
"Patience: Wait for High-Probability Setups":["When in Doubt, Wait it Out","Establish Setup Conditions and Screening Criteria","Shop the Odds"],
"Avoid Revenge Trading After a Loss":["Revenge Trading Avoidance","Paper Trading After a Losing Trade"],
"Dollar-Cost Averaging":["Dollar Cost Averaging"],
"Margin of Safety When Valuing a Stock":["Margin of Safety"],
"Interest Rates Affect Asset Prices":["Bond Spreads as Leading Indicator"],
"Currency Pairs Move on Interest Rate Differentials and News":["Carry Trade Strategy","Six Forces of Forex Analysis","Intervention Trading","Currency Correlation Trading","Macroeconomic Event Trading","Trade the Surprise Factor in Economic News Releases (Actual vs Consensus)","Currency Conversion"],
"Understand Implied Volatility Before Trading Options":["Option Volatility Timing","Volatility Smile Strategy","Option Pricing Models","Risk Reversals Strategy"],
"Compound Interest / Reinvest Returns":["Present Value Analysis","Acquire Income-Generating Assets, Not Liabilities"],
"Risk-Reward Ratio Before Entering a Trade":["Calculate Expectancy (Win Rate x Avg Win vs Avg Loss)","Calculate Expected Value and Monetary Value"],
"Set Clear Financial Goals":["Setting and Accomplishing Realistic Goals","Know Why You Trade","Investment Policy Statement Development"],
"Manage Expectations: Trading Is Not Gambling":["Consistent Modest Returns Beat Chasing Big Gains","Be Skeptical of Get-Rich-Quick Trading Claims","If It Sounds Too Good to Be True, It Probably Is"],
"Support and Resistance Levels":["Scale Into Positions Within a Support/Resistance Zone","Fading the Double Zeros","Value Area Trading"],
# new merged groups
"Elliott Wave Analysis":["Elliott Wave Pattern Analysis","Elliott Wave Theory for Market Cycles","Use Elliott Wave Pattern Analysis to Identify Trend vs Correction","Use Elliott Wave Theory to Identify Trend Structure","Elliott Wave Pattern Analysis for Entry/Exit Timing","Elliott Wave Pattern Analysis for Price Projections","Elliott Wave Pattern Analysis for Market Forecasting","Elliott Wave Principles","Wave Counting Rules","Elliott Wave Theory","Five-Wave Impulse Trend Structure","Three-Wave Correction Patterns","Market Waves and Wave Patterns"],
"Avoid Curve-Fitting / Over-Optimizing a System":["Avoid Curve-Fitting/Over-Optimizing a Trading System","Avoid Over-Optimizing/Curve-Fitting Trading Systems","Avoid Over-Optimizing / Curve-Fitting a System","Avoid Curve-Fitting a Trading System to Historical Data","Avoid Overfitting a Trading System (Curve-Fitting)","Distrust Hypothetical/Backtested Results Not Verified With Real Money"],
"Use Trailing Stops to Lock In Profits":["Use a Trailing Stop to Lock In Profits","Trail Stop-Loss to Lock in Profits","Trailing Stop Orders to Protect Profits","Trailing Stops"],
"Match Your Trading Method to Your Personality":["Develop a Trading System That Fits Your Personality","Match Trading Method to Your Personality","Trade According to Your Own Personality and Risk Tolerance","Develop a Trading Method That Fits Your Personality","Know Your Risk Tolerance Before Investing"],
"Kelly Criterion / Optimal f Position Sizing":["Kelly Criterion for Optimal Bet Sizing","Use Position Sizing Formulas (e.g., Kelly Criterion) to Optimize Bet Size","Use Kelly Criterion / Optimal f for Position Sizing","Kelly Criterion for Optimal Position Sizing"],
"Bollinger Bands for Volatility Extremes":["Bollinger Bands","Bollinger Bands Signal Volatility Extremes and Trading Opportunities","Use Bollinger Bands to Measure Volatility and Identify Overbought/Oversold Conditions","Bollinger Bands Trading"],
"Pyramid Into Winning Positions":["Add to Winning Positions Gradually (Pyramid Winners)","Add to Winning Positions (Pyramiding)","Pyramid Into Winning Positions Gradually","Add to Your Position Pyramid Style","Avoid Top-Heavy Pyramiding of Positions","Press Winning Positions Aggressively When Conviction Is High"],
"Scale In and Out of Positions":["Scale In and Out of Positions Gradually","Take Partial Profits and Let Remainder Run","Scale Out of Positions at Multiple Targets","Scale Into Positions Gradually"],
"Avoid Choppy / Range-Bound Markets":["Avoid Trading in Choppy/Range-Bound Markets"],
"Seasonal and Calendar Patterns":["Seasonal Market Patterns (e.g. Santa Claus Rally)","Seasonal Market Patterns (e.g., Sell in May, January Effect)","Seasonal Market Patterns (Calendar Effects)","Seasonal Patterns Affect Market Returns (e.g., January Barometer, Sell in May)","Best Six Months Calendar Strategy","Presidential Cycle Years Strategy","Presidential Election Cycle Affects Stock Returns","Weekend Effect in Currency Prices","Weekend Effect Trading"],
"Time Trades to the Best Market Sessions":["Time Trades to Optimal Market Hours/Sessions","Trading Session Timing"],
"Avoid Trading Around High-Volatility News":["Avoid Trading During High-Volatility News Events","Fade the News Strategy","Buy the Rumor, Sell the News"],
"Price Action Over Indicators; Use Multiple Confirmations":["Avoid Overreliance on Indicators; Price Action Comes First","Seek Confirmation From Multiple Indicators Before Acting","Require Multiple Confirming Signals Before Entering a Trade","Combine Multiple Technical Tools for Confirmation","Use Multiple Confirming Technical Tools Rather Than One Alone"],
"Follow Insider and Institutional Activity":["Follow Corporate Insider Buying and Selling","Insider Buying/Selling Signals Value","Follow Institutional Money Flow","Institutional Sponsorship Signals Stock Quality","Company Stock Buybacks Can Signal Confidence","Follow Commercial/Insider Positioning (COT Report)","Commitments of Traders (COT) Report Signals Sentiment Extremes"],
"Minimize Fees, Costs and Taxes":["Minimize Investment Fees and Expenses","Minimize Taxes and Fees to Maximize After-Tax Returns","Execution Cost Optimization","Use Corporate Structures for Tax Advantages"],
"Understand Order Types; Prefer Limit Orders":["Understand Order Types Before Trading","Use Limit Orders, Not Market Orders, When Trading","Limit Order Trading","Don't Place Orders At the Market","Best Execution Practices","Order Routing and Liquidity Management","Order Exposure Management","Information Leakage Reduction","Block Trading Execution","Upstairs Market Trading"],
"Treat Each Trade as Statistically Independent":["Treat Each Trade As Statistically Independent","Avoid Overreacting to Random Chance Events (Hot Hand Fallacy)","Avoid Martingale (Doubling Down After Losses) Betting Systems"],
"Be Skeptical of Gurus, Tips and Hype":["Be Skeptical of Gurus, Tips, and Market Hype","Be Wary of Gurus, Tips, and Unverified Experts","Avoid Following Media Experts and Market Letter Writers","Be Skeptical of Unsolicited Stock Tips","Don't Rely on Tips; Trade on Your Own Judgment","Trust Your Own Analysis, Avoid Outside Opinions","Be Mentally Independent","Avoid Discussing Trades With Others","Beware of Penny Stocks","Be Aware of Fraud Risk in Investments","Be Aware of Broker Conflicts of Interest in Forex Trading"],
"Guard Against Cognitive Biases":["Beware Cognitive Biases (Anchoring, Confirmation Bias)","Avoid Overconfidence and Behavioral Biases in Investing","Avoid Overconfidence in Investment Judgments","Avoid Hindsight Bias When Evaluating Decisions","Adopt Broad Framing, Avoid Narrow Framing","Loss Aversion Distorts Risk Decisions","Individual Investor Behavior Analysis"],
"Market Breadth and Sentiment Indicators":["Market Breadth Indicators Confirm Price Trend Strength","Use Market Breadth to Confirm Index Trends","Market Breadth Indicators Confirm Trend Strength","Market Breadth Indicators","Advance-Decline Line Analysis","Use Investor Sentiment Indicators to Identify Market Extremes","Put/Call Ratio as a Contrarian Sentiment Indicator","Put-Call Ratio Analysis","Market Sentiment Analysis","Volatility Index (VIX) Trading","Short Sales Statistics","Watch Bellwether Stocks for Market Direction"],
"Divergence Between Price and Indicators Signals Reversal":["Price-Momentum Divergence Signals Trend Reversal","Divergence Analysis","Trade Trend Exhaustion / Countertrend Reversal Signals","Trade Divergences from the Norm"],
"Relative Strength: Buy Market Leaders":["Relative Strength: Buy Stocks Outperforming the Market","Buy Stocks Showing Relative Strength vs Market","Momentum Investing: Buy High, Sell Higher","Stock Splits Can Signal Bullish Momentum"],
"Sector Rotation With the Economic Cycle":["Rotate Between Sectors Based on Economic Cycle","Rotate Portfolio Sectors With the Economic Cycle","Stock Sector Analysis","Use Top-Down Analysis: Market, Sector, Then Stock","Commodity Prices as Leading Indicator","Economic Indicators"],
"Tactical Asset Allocation on Valuation":["Tactical Asset Allocation Based on a Valuation Model","Tactical Asset Allocation Based on Valuation Signals","Market Timing Strategy","Value Line Arithmetic Index 4 Percent Strategy","Nasdaq Composite 6 Percent Strategy"],
"Quantify Portfolio Risk (VaR, Std Dev, Stress Tests)":["Use Value-at-Risk to Quantify Portfolio Risk","Use Value-at-Risk (VaR) Models to Measure Portfolio Risk","Value at Risk (VaR)","Stress Testing Portfolios","Quantify Risk Using Standard Deviation","Risk-Adjusted Return on Capital (RAROC)","Financial Mathematics for Trading","Higher Returns Require Taking More Risk"],
"Arbitrage and Market-Neutral Strategies":["Exploit Arbitrage Price Discrepancies Between Related Assets","Pairs Trading: Long Undervalued, Short Overvalued Correlated Assets","Pairs Trading Between Correlated Instruments","Market-Neutral Investing","Convertible Arbitrage","Fixed-Income Arbitrage","Merger Arbitrage","Equity Market Neutral","Statistical Arbitrage","Relative Value Arbitrage","Mortgage-Backed Securities Arbitrage","Spread Analysis"],
"Practice With Paper Trading First":["Practice on a Demo Account Before Trading Real Money","Paper Trade Before Risking Real Capital"],
"Concentrate in High-Conviction Ideas":["Concentrate Positions Rather Than Overdiversify","Concentrate Investments in a Few High-Conviction Ideas","Act Decisively on High-Conviction Trades, Investigate Later","Take Decisive Action Rather Than Overanalyzing"],
"Reflexivity: Markets Can Stay Irrational":["Reflexivity: Markets Are Inefficient and Self-Reinforcing","Reflexivity: Perception Shapes Market Fundamentals","Markets Can Remain Irrational Longer Than You Can Remain Solvent"],
"Maintain Physical and Mental Health":["Maintain Healthy Routines and Manage Stress/Burnout for Trading Performance","Maintain Physical and Mental Fitness for Trading"],
"Market Profile and Value-Area Analysis":["Market Profile Analysis","Range Development Analysis","Initiating and Responsive Activity Trading"],
"Price Gaps and Gap Trading":["Price Gaps Often Get Filled and Signal Continuation/Exhaustion","Trade Gaps Between Sessions (Gap Trading)"],
"Basic Options Strategies (Calls, Puts, Spreads, Covered Writes)":["Long Call Strategy","Long Put Strategy","Covered Call Strategy","Covered Put Strategy","Bull Call Spread Strategy","Bear Put Spread Strategy"],
"Evaluate Fund Managers and Performance Properly":["Perform Due Diligence on Fund Managers Before Investing","Investment Manager Selection and Monitoring","Fiduciary Responsibility and Prudent Investor Rule","Total Return Investment Measurement","Time-Weighted and Dollar-Weighted Returns"],
"Know and Define Your Trading Edge":["Know and Define Your Trading Edge","Create Entry Signal Based on Technical Setup","Pre-Market Planning and Preparation"],
"Mean Reversion and Fading Moves":["Mean Reversion Systems","Fader Strategy"],
"Short Selling":["Short Selling: Sell High, Buy Low","Short Selling"],
"Valuation Models (DCF, Real Options)":["Use Discounted Cash Flow Analysis to Value a Business","Value Managerial Flexibility (Real Options) in Investment Decisions","Higher Uncertainty Increases the Value of Optionality"],
}
rev={}
for c,vs in G.items():
  rev[c]=c
  for v in vs:
    assert v not in rev or rev[v]==c,(v,c); rev[v]=c
m=collections.defaultdict(set); src=collections.defaultdict(set)
names=set()
for f in sorted(glob.glob(os.path.join(HERE,'results','batch_*.json'))):
  for s in json.load(open(f)):
    n=s['strategy'].strip(); names.add(n); c=rev.get(n,n)
    m[c].update(s['files']); src[c].add(n)
out=sorted(m.items(),key=lambda kv:(-len(kv[1]),kv[0]))
print(len(out),'consolidated')
for c,fs in out: print(len(fs),'|',c,'| variants',len(src[c]))
json.dump([{"strategy":c,"count":len(fs),"variants":sorted(src[c]),"files":sorted(fs)} for c,fs in out],open(os.path.join(HERE,'consolidated.json'),'w'),indent=1)

# rankings.csv at project root (descriptions from descriptions.json; new groups get a blank description)
desc=json.load(open(os.path.join(HERE,'descriptions.json')))
with open(os.path.join(ROOT,'rankings.csv'),'w',newline='') as fh:
  w=csv.writer(fh); w.writerow(['rank','strategy','books','description','merged_variants','source_files'])
  for i,(c,fs) in enumerate(out,1):
    e=desc.get(c,{})
    w.writerow([i,e.get('display_name',c),len(fs),e.get('description',''),'; '.join(sorted(src[c])),'; '.join(sorted(fs))])
print('wrote consolidated.json and rankings.csv')
