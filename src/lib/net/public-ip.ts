import { BlockList, isIPv4, isIPv6 } from "node:net";

/**
 * Endereço IP público da internet (bloco I, I3: guarda de SSRF). Toda busca de saída a partir de algo
 * que o usuário digitou confere o IP para onde o host resolveu **antes de conectar**, mesmo com o host
 * numa lista fechada: um DNS envenenado ou uma resposta trocada não leva o servidor à rede interna,
 * ao próprio processo nem ao serviço de metadados da nuvem.
 *
 * Só servidor (`node:net`).
 */

/** Faixas que nunca são destino de uma busca de saída. Fontes: RFC 6890 e o registro da IANA. */
const IPV4_BLOCKED: [prefix: string, bits: number][] = [
  ["0.0.0.0", 8], // "esta rede"
  ["10.0.0.0", 8], // privada
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, inclusive o 169.254.169.254 dos metadados da nuvem
  ["172.16.0.0", 12], // privada
  ["192.0.0.0", 24], // atribuições do IETF
  ["192.0.2.0", 24], // documentação
  ["192.88.99.0", 24], // relay 6to4
  ["192.168.0.0", 16], // privada
  ["198.18.0.0", 15], // testes de desempenho
  ["198.51.100.0", 24], // documentação
  ["203.0.113.0", 24], // documentação
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reservada, inclusive 255.255.255.255
];

const IPV6_BLOCKED: [prefix: string, bits: number][] = [
  ["::", 96], // não especificado (`::`), loopback (`::1`) e o antigo IPv4-compatível
  ["::ffff:0:0", 96], // IPv4 mapeado: conferido pelo IPv4 de dentro (abaixo), e bloqueado aqui por garantia
  ["64:ff9b:1::", 48], // NAT64 local
  ["100::", 64], // descarte
  ["2001::", 23], // atribuições do IETF (Teredo, ORCHID, benchmarking)
  ["2001:db8::", 32], // documentação
  ["2002::", 16], // 6to4: carrega um IPv4 qualquer
  ["fc00::", 7], // ULA, inclusive o fd00:ec2::254 dos metadados da AWS
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (obsoleto)
  ["ff00::", 8], // multicast
];

/**
 * Uma lista por família: o `BlockList` do Node confere um IPv4 também contra as regras IPv6 que o
 * contêm (`::ffff:0:0/96`), e numa lista só todo IPv4 sairia bloqueado.
 */
const blockedV4 = new BlockList();
for (const [prefix, bits] of IPV4_BLOCKED) blockedV4.addSubnet(prefix, bits, "ipv4");
const blockedV6 = new BlockList();
for (const [prefix, bits] of IPV6_BLOCKED) blockedV6.addSubnet(prefix, bits, "ipv6");

/** Os 8 grupos de 16 bits de um IPv6 já validado (aceita `::` e o final em IPv4 pontuado). */
function ipv6Groups(address: string): number[] {
  let text = address.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);

  // Final em IPv4 pontuado (`::ffff:127.0.0.1`): vira os dois últimos grupos.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted?.[1]) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted[1].split(".").map(Number);
    text = `${text.slice(0, -dotted[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const [head = "", tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const missing = tail === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array<string>(missing).fill("0"), ...right].map((group) => Number.parseInt(group, 16));
}

/** O IPv4 dentro de um IPv6 mapeado (`::ffff:a.b.c.d`) ou NAT64 (`64:ff9b::a.b.c.d`), se houver. */
function embeddedIpv4(groups: number[]): string | null {
  const [g0, g1, g2, g3, g4, g5, g6 = 0, g7 = 0] = groups;
  const mapped = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff;
  const nat64 = g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0;
  if (!mapped && !nat64) return null;
  return [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff].join(".");
}

/**
 * `true` só para um IP público da internet. Texto que não é IP, faixa privada, loopback,
 * link-local, metadados, multicast e reservada dão `false` (falha fechada).
 */
export function isPublicIp(address: string): boolean {
  if (isIPv4(address)) return !blockedV4.check(address, "ipv4");
  if (!isIPv6(address)) return false;

  const groups = ipv6Groups(address);
  if (groups.length !== 8 || groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)) {
    return false;
  }

  const inner = embeddedIpv4(groups);
  if (inner !== null) {
    // NAT64 com IPv4 público é legítimo (rede só IPv6); mapeado é sempre recusado pela faixa.
    if (!isPublicIp(inner)) return false;
    if (groups[0] === 0x64) return true;
  }

  const normalized = groups.map((group) => group.toString(16)).join(":");
  return !blockedV6.check(normalized, "ipv6");
}
