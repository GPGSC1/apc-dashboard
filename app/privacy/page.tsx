export default function PrivacyPolicy() {
  return (
    <div style={{ maxWidth: 700, margin: "40px auto", padding: "0 20px", fontFamily: "sans-serif", color: "#e0e0e0", background: "#111", minHeight: "100vh" }}>
      <h1>Privacy Policy</h1>
      <p><strong>Last updated:</strong> April 1, 2026</p>

      <h2>Overview</h2>
      <p>This application is an internal sales performance dashboard. It is not a public-facing service and does not collect personal data from the general public.</p>

      <h2>Data Collection</h2>
      <p>The only personal data processed by this application is phone numbers voluntarily entered by authorized dashboard users for the purpose of receiving internal performance reports via SMS.</p>

      <h2>Use of Data</h2>
      <p>Phone numbers are used solely to deliver daily sales performance summaries to company owners and managers. Numbers are not stored permanently, shared with third parties, or used for marketing purposes.</p>

      <h2>SMS Messaging</h2>
      <p>Users opt in to receive SMS messages by manually entering their phone number and pressing the Send button on the dashboard. Messages contain internal business metrics only. Users can stop receiving messages at any time by simply not using the send feature. Message and data rates may apply.</p>

      <h2>Third-Party Services</h2>
      <p>SMS delivery is provided by Twilio. Their privacy policy is available at twilio.com/legal/privacy.</p>

      <h2>Contact</h2>
      <p>For questions about this policy, contact the dashboard administrator.</p>
    </div>
  );
}
