# Shelf Barcode Finder — iPhone + Android

Static HTTPS web app for retail shelf UPC scanning.

## Matching rule

The app matches the **last 4 digits of the UPC data portion**, excluding the UPC check digit.

Example:

- Scanned code: `95464834640`
- Data portion used for matching: `9546483464`
- Enter: `3464`

For a standard 12-digit UPC-A, the final digit is the check digit, so `012345678905` matches `7890`.

## Scanner behavior

- Android browsers with `BarcodeDetector`: uses the browser's native barcode scanner for fast multi-barcode detection.
- iPhone/Safari and browsers without `BarcodeDetector`: uses `@zxing/browser` and scans overlapping camera tiles to find multiple UPC/EAN barcodes.
- White boxes are drawn around every detected barcode.
- A match triggers a beep and MATCH FOUND state.

## GitHub Pages

Upload all files in this folder to a GitHub repository and enable GitHub Pages. Open the published address over HTTPS. Camera access will not work from an ordinary `file://` page.

The ZXing browser script is loaded from jsDelivr. No barcode images or decoded barcode values are uploaded by this app.
