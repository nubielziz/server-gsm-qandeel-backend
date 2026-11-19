// Brand data of the shop detection (feature 31, plan section 3.5; A3 section 4): device makers and apps or stores, each with the
// words that name it in a supplier's service name. Pure data; tested in lexicon.spec.ts.

/** A brand and the pattern of the words that name it. */
export type BrandPattern = readonly [brand: string, pattern: RegExp];

/**
 * Device makers (phones, tablets, laptops, operating systems), in the order the prototype measured them.
 *
 * Why: A3 section 4: the brand of an IMEI service is the device it works on. The traps are part of the patterns: `iphone`, never
 * `i?phone` (`Kyocera Phone` is not Apple); `nothing phone`, never `nothing` (`Nothing Tool` is an iPhone tool); `knox` but
 * not `Knoxwizard` (a tool); the chip codes `A5` to `A17` and `Hello Screen`, `Passcode`, `Ramdisk` mean an Apple device.
 */
export const DEVICE_BRANDS: readonly BrandPattern[] = [
  [
    'Apple',
    /\b(?:iphones?|ipads?|ipod|iwatch|apple|macbook|imac|mac(?:os)?|icloud|ios|fmi|airpods|ibridgeos|t2|ramdisk|passcode|hello\s+(?:screen|activator|bypass))\b|\bwatch\s?\d|\bA(?:[4-9]|1[0-7])[x+]?(?![0-9a-z])/i,
  ],
  ['Samsung', /\b(?:samsung|galaxy|sams|knox(?!wizard)|samkey|z3x sams)\b/i],
  ['Xiaomi', /\b(?:xiaomi|xioami|redmi|poco|mi[- ]?(?:account|cloud|fix|bypass|byass)|micloud)\b/i],
  ['Huawei', /\bhuawei\b/i],
  ['Honor', /\bhonor\b/i],
  ['OPPO', /\b(?:oppo|oplus|heytap)\b/i],
  ['OnePlus', /\boneplus\b/i],
  ['Realme', /\brealme\b/i],
  ['Vivo', /\bvivo\b/i],
  ['Tecno', /\btecno\b/i],
  ['Infinix', /\binfinix\b/i],
  ['Itel', /\bitel\b|\btel\b(?= \/ tecno)/i],
  ['Motorola', /\b(?:moto(?:rola)?)\b/i],
  ['Google', /\b(?:pixel|google)\b/i],
  ['LG', /\blg\b/i],
  ['Nokia', /\b(?:nokia|hmd)\b/i],
  ['Sony', /\bsony\b/i],
  ['ZTE', /\bzte\b/i],
  ['Alcatel', /\balcatel\b/i],
  ['Nothing', /\bnothing phone\b/i],
  ['Sharp', /\bsharp\b/i],
  ['Kyocera', /\bkyocera\b/i],
  ['Micromax', /\bmicromax\b/i],
  ['Lenovo', /\blenovo\b/i],
  ['Dell', /\bdell\b/i],
  ['HP', /\bhp\b/i],
];

/**
 * Apps, stores and subscriptions; the one named earliest in the text is the brand.
 *
 * Why: A3 section 4: gift cards, accounts and licences are sold by the app's name. Earliest wins, so `Apple ID ... (Microsoft
 * Mail)` is Apple and `Dhru Fusion - Telegram ...` is Dhru Fusion.
 */
export const APP_BRANDS: readonly BrandPattern[] = [
  ['iTunes', /\bitunes\b/i],
  ['PlayStation', /\b(?:playstation|psn)\b/i],
  ['Roblox', /\broblox\b/i],
  ['PUBG Mobile', /\bpubg\b/i],
  ['Free Fire', /\bfree fire\b/i],
  ['Netflix', /\bnetflix\b/i],
  ['Spotify', /\bspotify\b/i],
  ['Disney+', /\bdisney\b/i],
  ['HBO Max', /\bhbo\b/i],
  ['Paramount+', /\bparamount\b/i],
  ['Prime Video', /\bprime video\b/i],
  ['YouTube', /\byoutube\b/i],
  ['Apple Music', /\bapple music\b/i],
  ['Apple TV', /\bapple tv\b/i],
  ['Tidal', /\btidal\b/i],
  ['Crunchyroll', /\bcrunchyroll\b/i],
  ['DirecTV', /\bdirectv\b/i],
  ['Magis TV', /\bmagis tv\b/i],
  ['NBA League Pass', /\bnba\b/i],
  ['UFC Fight Pass', /\bufc\b/i],
  ['Adobe', /\badobe\b/i],
  ['Canva', /\bcanva\b/i],
  ['Telegram', /\btelegram\b/i],
  ['NordVPN', /\bnordvpn\b/i],
  ['Kaspersky', /\bkaspersky\b/i],
  ['Microsoft', /\b(?:microsoft|windows\s?\d+|office 365)\b/i],
  ['Internet Download Manager', /\binternet download manager\b/i],
  ['Parallels', /\bparallel desktop\b/i],
  ['Facebook', /\bfacebook\b/i],
  ['Instagram', /\binstagram\b/i],
  ['TikTok', /\btiktok\b/i],
  ['WhatsApp', /\bwhatsapp\b/i],
  ['Dhru Fusion', /\bdhru fusion\b/i],
  ['Mobiledit', /\bmobiledit\b/i],
  ['XRY', /\bxry/i],
  ['Apple', /\bapple id\b/i],
  ['beIN Sports', /\bvip\b.*\bserial\b/i],
];
