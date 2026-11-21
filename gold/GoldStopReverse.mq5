//+------------------------------------------------------------------+
//| GoldStopReverse.mq5                                               |
//| Скальпер на золоті за логікою з відео: позиція + зустрічний       |
//| стоп-ордер на сервері брокера + трейлінг, з ризик-менеджментом.   |
//|                                                                  |
//| Пресети (перевір обидва в тестері: «Кожен тік на основі реальних  |
//| тіків», XAUUSD, 3–6 місяців, депозит 200):                         |
//|  • «Як на відео»:  Mode=Reverse, Step=0.30, TakeProfit=0,          |
//|                    StartHour=0, EndHour=24                          |
//|  • «Найкраща»:     Mode=Rearm,   Step=8.0,  TakeProfit=16,          |
//|                    StartHour=7,  EndHour=20 (UTC, Лондон+НЙ)        |
//| Бектест: gold/backtest.mjs, звіт docs/gold-scalper.md               |
//+------------------------------------------------------------------+
#property copyright "Odds"
#property version   "1.00"
#property description "Gold stop-and-reverse scalper with risk management (daily loss, drawdown kill-switch, spread & session filters)."

#include <Trade/Trade.mqh>

enum ENUM_SR_MODE
  {
   SR_REVERSE = 0, // Переворот (як на відео)
   SR_REARM   = 1  // Нова вилка після виходу
  };

input group "Логіка"
input ENUM_SR_MODE InpMode        = SR_REARM; // Режим
input double       InpStep        = 8.0;      // Відстань стоп-ордерів і трейлінгу, $ (на відео 0.30)
input double       InpTakeProfit  = 16.0;     // Тейк-профіт, $ (0 = без)
input double       InpMinModify   = 0.05;     // Мінімальний крок переставляння ордерів, $
input int          InpMinModifyMs = 300;      // Не частіше ніж раз на N мс

input group "Обсяг і ризик"
input double InpLots           = 0.01;  // Лот (0.01 = 1 унція)
input double InpRiskPct        = 0.0;   // Або ризик на угоду, % капіталу (0 = фіксований лот)
input double InpMaxSpread      = 0.40;  // Макс. спред, $ (ширше — нових входів немає)
input double InpDailyLossPct   = 5.0;   // Денний ліміт втрат, % (до кінця дня — стоп)
input double InpMaxDrawdownPct = 20.0;  // Kill-switch: просідання від піку, % (стоп до перезапуску)

input group "Час (час сервера брокера)"
input int  InpStartHour       = 7;     // Початок торгівлі, година
input int  InpEndHour         = 20;    // Кінець торгівлі, година (24 = до кінця дня)
input bool InpCloseOutside    = true;  // Поза годинами закривати все
input int  InpFridayCloseHour = 20;    // П'ятниця: закрити все з цієї години

input group "Технічне"
input ulong InpMagic          = 260411; // Magic number
input int   InpSlippagePoints = 30;     // Допустиме проковзування, пунктів

CTrade   trade;
double   g_hi = 0, g_lo = 0, g_ext = 0;
bool     g_armed = false;
int      g_lastPosType = -1;
double   g_peakEquity = 0, g_dayStartEquity = 0;
int      g_day = -1;
bool     g_killed = false, g_dayStop = false;
ulong    g_lastModifyMs = 0;

//--- допоміжні
double Mid()    { return (SymbolInfoDouble(_Symbol, SYMBOL_BID) + SymbolInfoDouble(_Symbol, SYMBOL_ASK)) / 2.0; }
double Spread() { return SymbolInfoDouble(_Symbol, SYMBOL_ASK) - SymbolInfoDouble(_Symbol, SYMBOL_BID); }
double Tick()   { double t = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE); return t > 0 ? t : _Point; }
double NormPrice(double p) { double t = Tick(); return NormalizeDouble(MathRound(p / t) * t, _Digits); }
double StopsGap()
  {
   long a = SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL), b = SymbolInfoInteger(_Symbol, SYMBOL_TRADE_FREEZE_LEVEL);
   long lvl = a > b ? a : b;
   return (double)(lvl + 1) * _Point;
  }
int DayOf(datetime t) { MqlDateTime d; TimeToStruct(t, d); return d.year * 1000 + d.day_of_year; }

double Lots()
  {
   double vmin = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN), vmax = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX), vstep = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   double lots = InpLots;
   if(InpRiskPct > 0)
     {
      double tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
      double lossPerLot = (InpStep + Spread()) / Tick() * tickValue;
      if(lossPerLot > 0) lots = AccountInfoDouble(ACCOUNT_EQUITY) * InpRiskPct / 100.0 / lossPerLot;
     }
   if(vstep > 0) lots = MathFloor(lots / vstep) * vstep;
   return NormalizeDouble(MathMax(vmin, MathMin(vmax, lots)), 2);
  }

bool InSession()
  {
   MqlDateTime d; TimeToStruct(TimeCurrent(), d);
   if(d.day_of_week == 0 || d.day_of_week == 6) return false;
   if(d.day_of_week == 5 && d.hour >= InpFridayCloseHour) return false;
   if(InpStartHour <= InpEndHour) return d.hour >= InpStartHour && d.hour < InpEndHour;
   return d.hour >= InpStartHour || d.hour < InpEndHour;
  }

//--- позиція й ордери цього робота
bool MyPosition(ulong &ticket, int &type, double &open, double &sl, double &tp)
  {
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong t = PositionGetTicket(i);
      if(t == 0 || !PositionSelectByTicket(t)) continue;
      if(PositionGetInteger(POSITION_MAGIC) != (long)InpMagic || PositionGetString(POSITION_SYMBOL) != _Symbol) continue;
      ticket = t;
      type   = (int)PositionGetInteger(POSITION_TYPE);
      open   = PositionGetDouble(POSITION_PRICE_OPEN);
      sl     = PositionGetDouble(POSITION_SL);
      tp     = PositionGetDouble(POSITION_TP);
      return true;
     }
   return false;
  }

ulong FindOrder(ENUM_ORDER_TYPE type, double &price)
  {
   for(int i = OrdersTotal() - 1; i >= 0; i--)
     {
      ulong t = OrderGetTicket(i);
      if(t == 0 || !OrderSelect(t)) continue;
      if(OrderGetInteger(ORDER_MAGIC) != (long)InpMagic || OrderGetString(ORDER_SYMBOL) != _Symbol) continue;
      if((ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE) != type) continue;
      price = OrderGetDouble(ORDER_PRICE_OPEN);
      return t;
     }
   return 0;
  }

void DeleteOrders()
  {
   for(int i = OrdersTotal() - 1; i >= 0; i--)
     {
      ulong t = OrderGetTicket(i);
      if(t == 0 || !OrderSelect(t)) continue;
      if(OrderGetInteger(ORDER_MAGIC) == (long)InpMagic && OrderGetString(ORDER_SYMBOL) == _Symbol) trade.OrderDelete(t);
     }
  }

void CloseAll()
  {
   DeleteOrders();
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong t = PositionGetTicket(i);
      if(t == 0 || !PositionSelectByTicket(t)) continue;
      if(PositionGetInteger(POSITION_MAGIC) == (long)InpMagic && PositionGetString(POSITION_SYMBOL) == _Symbol) trade.PositionClose(t);
     }
   g_armed = false;
  }

bool CanModify() { return GetTickCount64() - g_lastModifyMs >= (ulong)InpMinModifyMs; }
void Modified()  { g_lastModifyMs = GetTickCount64(); }

// Поставити або підтягнути стоп-ордер на потрібну ціну (з SL на відстані Step і тейком)
void PlaceOrMove(ENUM_ORDER_TYPE type, double price)
  {
   price = NormPrice(price);
   bool buy = (type == ORDER_TYPE_BUY_STOP);
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK), bid = SymbolInfoDouble(_Symbol, SYMBOL_BID), gap = StopsGap();
   if(buy && price < ask + gap)  price = NormPrice(ask + gap);
   if(!buy && price > bid - gap) price = NormPrice(bid - gap);
   double sl = NormPrice(buy ? price - InpStep : price + InpStep);
   double tp = InpTakeProfit > 0 ? NormPrice(buy ? price + InpTakeProfit : price - InpTakeProfit) : 0;
   double cur = 0;
   ulong t = FindOrder(type, cur);
   if(t == 0)
     {
      bool ok = buy ? trade.BuyStop(Lots(), price, _Symbol, sl, tp, ORDER_TIME_GTC, 0, "GSR")
                    : trade.SellStop(Lots(), price, _Symbol, sl, tp, ORDER_TIME_GTC, 0, "GSR");
      if(ok) Modified();
      return;
     }
   if(MathAbs(cur - price) >= InpMinModify && CanModify())
      if(trade.OrderModify(t, price, sl, tp, ORDER_TIME_GTC, 0)) Modified();
  }

void DeleteOrder(ENUM_ORDER_TYPE type)
  {
   double p = 0;
   ulong t = FindOrder(type, p);
   if(t != 0) trade.OrderDelete(t);
  }

//--- ризик: денний ліміт і kill-switch
bool RiskOk()
  {
   double eq = AccountInfoDouble(ACCOUNT_EQUITY);
   int day = DayOf(TimeCurrent());
   if(day != g_day) { g_day = day; g_dayStartEquity = eq; g_dayStop = false; }
   if(eq > g_peakEquity) g_peakEquity = eq;
   if(!g_killed && InpMaxDrawdownPct > 0 && eq <= g_peakEquity * (1.0 - InpMaxDrawdownPct / 100.0))
     {
      g_killed = true;
      CloseAll();
      Alert("GoldStopReverse: KILL-SWITCH — просідання ", DoubleToString(InpMaxDrawdownPct, 1), "% від піку. Усе закрито, торгівлю зупинено до перезапуску.");
     }
   if(!g_dayStop && InpDailyLossPct > 0 && eq <= g_dayStartEquity * (1.0 - InpDailyLossPct / 100.0))
     {
      g_dayStop = true;
      CloseAll();
      Alert("GoldStopReverse: денний ліміт втрат ", DoubleToString(InpDailyLossPct, 1), "% — стоп до завтра.");
     }
   return !g_killed && !g_dayStop;
  }

//+------------------------------------------------------------------+
int OnInit()
  {
   if(InpStep <= 0 || InpLots <= 0) { Print("Step і Lots мають бути > 0"); return INIT_PARAMETERS_INCORRECT; }
   if(StringFind(_Symbol, "XAU") < 0 && StringFind(_Symbol, "GOLD") < 0) Print("Увага: робот розрахований на золото (XAUUSD), а графік — ", _Symbol);
   trade.SetExpertMagicNumber(InpMagic);
   trade.SetDeviationInPoints(InpSlippagePoints);
   trade.SetTypeFillingBySymbol(_Symbol);
   g_peakEquity = AccountInfoDouble(ACCOUNT_EQUITY);
   g_dayStartEquity = g_peakEquity;
   g_day = DayOf(TimeCurrent());
   PrintFormat("GoldStopReverse: режим %s, крок %.2f$, тейк %.2f$, лот %.2f, години %d–%d, kill-switch %.1f%%",
               InpMode == SR_REVERSE ? "переворот" : "нова вилка", InpStep, InpTakeProfit, Lots(), InpStartHour, InpEndHour, InpMaxDrawdownPct);
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason) { Comment(""); }

void OnTick()
  {
   if(!RiskOk()) { Comment("GoldStopReverse: зупинено (", g_killed ? "kill-switch" : "денний ліміт", ")"); return; }
   if(!InSession())
     {
      if(InpCloseOutside) CloseAll(); else DeleteOrders();
      g_armed = false;
      Comment("GoldStopReverse: поза торговими годинами");
      return;
     }

   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID), ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK), mid = Mid();
   ulong ticket; int type; double open, sl, tp;
   bool hasPos = MyPosition(ticket, type, open, sl, tp);

   if(hasPos)
     {
      if(type != g_lastPosType) // нова позиція: прибрати «вилку», почати трейлінг від ціни входу
        {
         DeleteOrders();
         g_ext = open;
         g_lastPosType = type;
        }
      if(type == POSITION_TYPE_BUY)
        {
         g_ext = MathMax(g_ext, bid);
         double nsl = NormPrice(g_ext - InpStep);
         if(nsl > sl + InpMinModify && nsl < bid - StopsGap() && CanModify())
            if(trade.PositionModify(ticket, nsl, tp)) { Modified(); sl = nsl; }
         if(InpMode == SR_REVERSE && sl > 0) PlaceOrMove(ORDER_TYPE_SELL_STOP, sl); // зустрічний ордер точно на рівні стопа
        }
      else
        {
         g_ext = MathMin(g_ext, ask);
         double nsl = NormPrice(g_ext + InpStep);
         if((sl == 0 || nsl < sl - InpMinModify) && nsl > ask + StopsGap() && CanModify())
            if(trade.PositionModify(ticket, nsl, tp)) { Modified(); sl = nsl; }
         if(InpMode == SR_REVERSE && sl > 0) PlaceOrMove(ORDER_TYPE_BUY_STOP, sl);
        }
      g_armed = false;
     }
   else
     {
      if(g_lastPosType != -1) // позиція щойно закрилась (стоп або тейк)
        {
         g_lastPosType = -1;
         if(InpMode == SR_REARM) DeleteOrders();
         g_armed = false;
        }
      if(Spread() > InpMaxSpread) { DeleteOrders(); g_armed = false; Comment("GoldStopReverse: спред ", DoubleToString(Spread(), 2), "$ > ліміту"); return; }
      if(!g_armed) { g_hi = mid; g_lo = mid; g_armed = true; }
      g_hi = MathMax(g_hi, mid);
      g_lo = MathMin(g_lo, mid);
      double half = Spread() / 2.0;
      PlaceOrMove(ORDER_TYPE_BUY_STOP,  g_lo + InpStep + half); // спрацює, коли середня ціна підніметься на Step від мінімуму
      PlaceOrMove(ORDER_TYPE_SELL_STOP, g_hi - InpStep - half); // спрацює, коли опуститься на Step від максимуму
     }

   double eq = AccountInfoDouble(ACCOUNT_EQUITY);
   Comment(StringFormat("GoldStopReverse | %s, крок %.2f$ | капітал %.2f | пік %.2f | день %.2f | спред %.2f$",
                        InpMode == SR_REVERSE ? "переворот" : "нова вилка", InpStep, eq, g_peakEquity, eq - g_dayStartEquity, Spread()));
  }
//+------------------------------------------------------------------+
