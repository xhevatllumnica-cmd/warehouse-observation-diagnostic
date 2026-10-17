# WMS Station — instalimi në kompjuterët e tavolinave

Zgjerimi i tregon Tabelës ditore **cila llogari e WMS-it është e kyçur** në këtë kompjuter. Tavolinën e njeh agjenti nga IP-ja e kompjuterit (lista: `data/station-ips.json`). Zgjerimi lexon vetëm emrin në kokën e faqes së WMS-it. Nuk lexon cookie, porosi apo të dhëna të tjera.

| Tavolina | PC (IP) | Stacioni në WMS |
|---|---|---|
| Tavolina 1 | 10.10.1.148 | CHECKOUT 1 |
| Tavolina 2 | 10.10.1.239 | CHECKOUT 2 |
| Tavolina 3 | 10.10.1.193 | CHECKOUT 3 |
| Tavolina 4 | 10.10.1.211 | CHECKOUT 4 |
| Tavolina 5 | — (jo funksionale tani) | CHECKIN & CHECKOUT |
| Tavolina 6 | 10.10.1.209 | CHECKIN 1 |
| Tavolina 7 | 10.10.1.241 | CHECKIN 2 |

## Një herë, në kompjuterin e agjentit
1. Agjenti duhet të jetë i ndezur. Krijon vetë çelësin e stacioneve.
2. `node station-extension/make-config.js` shkruan `config.js`, me adresën e agjentit (`http://10.10.1.230:8791`) dhe çelësin.
3. Ky kompjuter duhet ta mbajë **IP-në 10.10.1.230**. Kërkoni nga IT një rezervim DHCP për të. Nëse IP-ja ndryshon, rregullohet te dritarja e zgjerimit, në fushën "Adresa e agjentit".

## Në secilin kompjuter të tavolinës (Chrome)
1. Kopjoni dosjen `station-extension`, **bashkë me `config.js`**, p.sh. në `C:\WMS-Station`.
2. Në Chrome hapni `chrome://extensions`, ndizni **Developer mode** (lart djathtas) dhe zgjidhni **Load unpacked** → dosjen `C:\WMS-Station`.
3. Hapni WMS-in dhe kyçuni. Klikoni ikonën **WMS Station**: duhet të shfaqet p.sh. "Tavolina 1 (CHECKOUT 1 · 10.10.1.148)" dhe emri i llogarisë.
4. Në Tabelën ditore, rreshti "PC-të e tavolinave" e tregon këtë tavolinë me ● të gjelbër.

## Si funksionon
- Çdo minutë, dhe sa herë hapet një faqe e WMS-it, zgjerimi dërgon emrin e llogarisë së kyçur. Kur nuk ka faqe të WMS-it të hapur, dërgon "askush".
- Agjenti ruan intervalet "llogaria X e kyçur në Tavolinën N nga … deri …". Puna e secilit (skanimet në WMS) i llogaritet tavolinës ku ishte i kyçur në atë kohë.
- Kur një operator ndërron tavolinë, Tabela ndjek vetë. Nuk ka më nevojë për caktim manual.
- Porti 8791 pranon vetëm adresa 10.10.1.x dhe vetëm me çelësin. Pjesa tjetër e app-it mbetet vetëm në kompjuterin e agjentit.
