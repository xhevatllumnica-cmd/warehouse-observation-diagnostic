# WMS Station — instalimi në kompjuterët e tavolinave

Zgjerimi i tregon Tabelës ditore **cila llogari e WMS-it është e kyçur** në këtë kompjuter. Tavolinën e njeh agjenti nga IP-ja e kompjuterit (lista: `data/station-ips.json`). Zgjerimi lexon vetëm emrin në kokën e faqes së WMS-it. Nuk lexon cookie, porosi apo të dhëna të tjera.

**Pse duhet:** WMS-i ruan vetëm *kush* skanoi dhe *kur*, jo *në cilin kompjuter*. Pa zgjerimin, Tabela e hamendëson tavolinën nga tavolina e zakonshme e personit. Kur dikush ndërron tavolinë gjatë ditës, duhet korrigjuar me dorë. Me zgjerimin, Tabela e di saktë kush është ku dhe nga kur deri kur.

## Tavolinat

| Tavolina | PC (IP) | Stacioni në WMS | Zgjerimi |
|---|---|---|---|
| Tavolina 1 | 10.10.1.148 | CHECKOUT 1 | ☐ |
| Tavolina 2 | 10.10.1.239 | CHECKOUT 2 | ☐ |
| Tavolina 3 | 10.10.1.193 | CHECKOUT 3 | ☐ |
| Tavolina 4 | 10.10.1.211 | CHECKOUT 4 | ☐ |
| Tavolina Check-out 5 | 10.10.1.106 | CHECKOUT 5 | ☐ |
| Tavolina 6 | 10.10.1.209 | CHECKIN 1 | ☐ |
| Tavolina 7 | 10.10.1.241 | CHECKIN 2 | ☐ |
| Tavolina Check-in 3 | 10.10.1.48 | CHECKIN 3 | ☐ |
| Tavolina 5 | — (pasive që nga 14.10.2026) | CHECKIN & CHECKOUT | — |

Një PC me IP që nuk është në listë nuk numërohet. Dritarja e zgjerimit tregon "IP … nuk është në listën e tavolinave". Nëse një tavolinë merr IP tjetër, ose hapet një tavolinë e re, IP-ja shtohet te `data/station-ips.json` në PC-në e agjentit.

## 1. IT — IP fikse për çdo PC (rezervim DHCP me MAC)

Tavolina njihet nga IP-ja. Nëse ruteri i jep PC-së një IP tjetër, p.sh. pas rindezjes, tavolina ngatërrohet. Kërkoni nga IT një **rezervim DHCP** (sipas adresës MAC) për:
- secilin PC të tavolinave, me IP-të e tabelës më sipër;
- PC-në e agjentit, **10.10.1.230**, sepse zgjerimet dërgojnë raportet atje.

Adresën MAC të një PC-je e gjeni me `ipconfig /all` → "Physical Address" e kartës që ka IP-në 10.10.1.x.

## 2. Një herë, në kompjuterin e agjentit (është bërë më 19.10.2026)
1. Agjenti duhet të jetë i ndezur. Krijon vetë çelësin e stacioneve.
2. `node station-extension/make-config.js 10.10.1.230` shkruan `config.js`, me adresën e agjentit (`http://10.10.1.230:8791`) dhe çelësin.
3. Dosja gati për kopjim, bashkë me `config.js`: **`Desktop\WMS-Station`**.

`config.js` përmban çelësin e stacioneve. Dosjen e kopjoni vetëm me USB ose me një dosje të përbashkët të brendshme. Mos e dërgoni me email apo chat, dhe mos e vendosni në git.

## 3. Në secilin kompjuter të tavolinës (Chrome), rreth 2 minuta
1. Kopjoni dosjen `WMS-Station` në **`C:\WMS-Station`**.
2. Në Chrome hapni `chrome://extensions` dhe ndizni **Developer mode** (lart djathtas).
3. Klikoni **Load unpacked** dhe zgjidhni dosjen `C:\WMS-Station`.
4. Hapni WMS-in dhe kyçuni me llogarinë e operatorit.
5. Klikoni ikonën **WMS Station** (🧩 → shënojeni me 📌 që të duket gjithmonë). Duhet të shfaqet p.sh. "Tavolina 1 (CHECKOUT 1 · 10.10.1.148)" dhe emri i llogarisë.
6. Shënoni ☑ te tabela më sipër.

Chrome mund të shfaqë njoftimin "Disable developer mode extensions" kur hapet. Klikoni ✕ (mos zgjidhni "Disable").

## 4. Verifikimi
- Në Tabelën ditore, rreshti "PC-të e tavolinave" e tregon tavolinën me ● të gjelbër dhe emrin e llogarisë së kyçur.
- Pas disa minutash pune, karta e tavolinës tregon operatorin nga kyçja reale, jo nga hamendësimi.

## Si funksionon
- Çdo minutë, dhe sa herë hapet një faqe e WMS-it, zgjerimi dërgon emrin e llogarisë së kyçur. Kur nuk ka faqe të WMS-it të hapur, dërgon "askush".
- Agjenti ruan intervalet "llogaria X e kyçur në Tavolinën N nga … deri …" për 14 ditë. Puna e secilit (skanimet në WMS) i llogaritet tavolinës ku ishte i kyçur në atë kohë.
- Kur një operator ndërron tavolinë, Tabela ndjek vetë. Nuk ka më nevojë për caktim manual.
- **Rregull pune:** secili operator kyçet me llogarinë e vet. Nëse dikush punon me llogarinë e një kolegu, puna i shkon kolegut.
- Porti 8791 pranon vetëm adresa 10.10.1.x dhe vetëm me çelësin. Pjesa tjetër e app-it mbetet vetëm në kompjuterin e agjentit.

## Probleme të shpeshta
| Çfarë shihni në dritaren e zgjerimit | Shkaku | Zgjidhja |
|---|---|---|
| "IP 10.10.1.… nuk është në listë" | PC-ja ka IP tjetër nga lista | Rezervim DHCP (hapi 1), ose shtoni IP-në te `data/station-ips.json` |
| "agjenti nuk përgjigjet" | PC-ja e agjentit e fikur, ose IP-ja e saj ndryshoi | Ndizni PC-në e agjentit. Nëse IP-ja ndryshoi, vendoseni te fusha "Adresa e agjentit" në dritaren e zgjerimit dhe klikoni "Ruaj" |
| Llogaria: "— asnjë —" | WMS-i nuk është i hapur ose s'jeni kyçur | Hapni WMS-in dhe kyçuni |
| "IP ? nuk është në listë" dhe "çelësi i stacionit mungon ose është gabim" | `config.js` i vjetër ose mungon | Kopjoni sërish dosjen nga PC-ja e agjentit |
