import { describe, expect, it } from "vitest";
import { parseAutoconfigXml } from "./autoconfig-xml.js";

const VALID_CONFIG = `<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="example.com">
    <domain>example.com</domain>
    <displayName>Example</displayName>
    <incomingServer type="imap">
      <hostname>imap.example.com</hostname>
      <port>993</port>
      <socketType>SSL</socketType>
      <username>%EMAILADDRESS%</username>
      <authentication>password-cleartext</authentication>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>smtp.example.com</hostname>
      <port>587</port>
      <socketType>STARTTLS</socketType>
      <username>%EMAILADDRESS%</username>
      <authentication>password-cleartext</authentication>
    </outgoingServer>
  </emailProvider>
</clientConfig>`;

describe("parseAutoconfigXml", () => {
  it("extracts IMAP and SMTP connection settings from a well-formed config", () => {
    const result = parseAutoconfigXml(VALID_CONFIG);
    expect(result).toEqual({
      imap: { host: "imap.example.com", port: 993, security: "tls" },
      smtp: { host: "smtp.example.com", port: 587, security: "starttls" },
    });
  });

  it("skips a non-imap incomingServer entry and uses the imap one", () => {
    const withPop3First = VALID_CONFIG.replace(
      '<incomingServer type="imap">',
      `<incomingServer type="pop3">
        <hostname>pop.example.com</hostname>
        <port>995</port>
        <socketType>SSL</socketType>
      </incomingServer>
      <incomingServer type="imap">`,
    );
    expect(parseAutoconfigXml(withPop3First)).toEqual({
      imap: { host: "imap.example.com", port: 993, security: "tls" },
      smtp: { host: "smtp.example.com", port: 587, security: "starttls" },
    });
  });

  it("returns null for a marketing-page redirect body, not XML at all", () => {
    expect(parseAutoconfigXml("<html><body>Not found</body></html>")).toBeNull();
  });

  it("returns null when only an incoming server is present", () => {
    const imapOnly = `<clientConfig version="1.1">
      <emailProvider id="example.com">
        <domain>example.com</domain>
        <incomingServer type="imap">
          <hostname>imap.example.com</hostname>
          <port>993</port>
          <socketType>SSL</socketType>
        </incomingServer>
      </emailProvider>
    </clientConfig>`;
    expect(parseAutoconfigXml(imapOnly)).toBeNull();
  });

  it("returns null for garbage input", () => {
    expect(parseAutoconfigXml("not xml at all {{{")).toBeNull();
  });

  it("returns null for an unrecognized socketType", () => {
    const bad = VALID_CONFIG.replace(
      "<socketType>SSL</socketType>",
      "<socketType>WEIRD</socketType>",
    );
    expect(parseAutoconfigXml(bad)).toBeNull();
  });
});
