import { describe, expect, it } from "vitest";
import { isPublicIp } from "@/lib/net/public-ip";

describe("isPublicIp", () => {
  it.each([
    "142.250.219.225",
    "8.8.8.8",
    "1.1.1.1",
    "2800:3f0:4001:817::2001",
    "2607:f8b0:4004:c07::64",
    // NAT64 com IPv4 público: rede só IPv6 alcança o Google assim.
    "64:ff9b::8efa:dbe1",
    "64:ff9b::142.250.219.225",
  ])("público: %s", (address) => {
    expect(isPublicIp(address)).toBe(true);
  });

  it.each([
    ["loopback", "127.0.0.1"],
    ["loopback no fim da faixa", "127.255.255.254"],
    ["esta rede", "0.0.0.0"],
    ["privada 10/8", "10.0.0.5"],
    ["privada 172.16/12", "172.16.0.1"],
    ["privada 172.31", "172.31.255.255"],
    ["privada 192.168/16", "192.168.1.1"],
    ["CGNAT", "100.64.0.1"],
    ["metadados da nuvem", "169.254.169.254"],
    ["link-local", "169.254.1.1"],
    ["documentação", "192.0.2.10"],
    ["testes de desempenho", "198.18.0.1"],
    ["multicast", "224.0.0.1"],
    ["reservada", "240.0.0.1"],
    ["broadcast", "255.255.255.255"],
    ["IPv6 não especificado", "::"],
    ["IPv6 loopback", "::1"],
    ["IPv6 loopback por extenso", "0:0:0:0:0:0:0:1"],
    ["IPv4 mapeado (loopback)", "::ffff:127.0.0.1"],
    ["IPv4 mapeado (metadados)", "::ffff:169.254.169.254"],
    ["IPv4 mapeado em hexa", "::ffff:7f00:1"],
    ["IPv4 mapeado (público, ainda assim recusado)", "::ffff:8.8.8.8"],
    ["IPv4 compatível (obsoleto)", "::127.0.0.1"],
    ["NAT64 apontando para privada", "64:ff9b::10.0.0.1"],
    ["NAT64 apontando para metadados", "64:ff9b::a9fe:a9fe"],
    ["NAT64 local", "64:ff9b:1::1"],
    ["ULA", "fd00::1"],
    ["metadados da AWS em IPv6", "fd00:ec2::254"],
    ["link-local IPv6", "fe80::1"],
    ["link-local com zona", "fe80::1%eth0"],
    ["site-local", "fec0::1"],
    ["multicast IPv6", "ff02::1"],
    ["documentação IPv6", "2001:db8::1"],
    ["Teredo", "2001:0:4136:e378::1"],
    ["6to4", "2002:7f00:1::1"],
    ["descarte", "100::1"],
    ["não é IP", "docs.google.com"],
    ["vazio", ""],
    ["IPv4 com zeros à esquerda", "010.0.0.1"],
    ["IPv4 em decimal", "2130706433"],
  ])("recusado: %s (%s)", (_label, address) => {
    expect(isPublicIp(address)).toBe(false);
  });
});
