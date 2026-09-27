/*
 * Gate Pass public web URL.
 *
 * For production / Internet-wide QR verification, set this to the PUBLIC HTTPS URL
 * where the frontend is hosted, for example:
 *   window.TNP_PUBLIC_BASE_URL = 'https://campus.example.edu';
 *
 * Do NOT put localhost or a private 192.168.x.x address here if the QR must work from
 * phones on mobile data or from networks outside the campus. Leave it empty when the
 * portal itself is already hosted at its final public URL; the current origin is used.
 */
window.TNP_PUBLIC_BASE_URL = '';
// Optional: public Express backend URL when the static frontend is hosted separately.
window.TNP_BACKEND_URL = '';
