# pylint: disable=too-many-lines, arguments-differ
from enum import Enum

"""
Constants required for multihash implementation
Ported from https://github.com/hareeshnagaraj/py-multihash
"""
names = {
    "md5": 0xD5,
    "sha1": 0x11,
    "sha2-256": 0x12,
    "sha2-512": 0x13,
    "dbl-sha2-256": 0x56,
    "sha3-224": 0x17,
    "sha3-256": 0x16,
    "sha3-384": 0x15,
    "sha3-512": 0x14,
    "shake-128": 0x18,
    "shake-256": 0x19,
    "keccak-224": 0x1A,
    "keccak-256": 0x1B,
    "keccak-384": 0x1C,
    "keccak-512": 0x1D,
    "murmur3-128": 0x22,
    "murmur3-32": 0x23,
    "blake2b-8": 0xB201,
    "blake2b-16": 0xB202,
    "blake2b-24": 0xB203,
    "blake2b-32": 0xB204,
    "blake2b-40": 0xB205,
    "blake2b-48": 0xB206,
    "blake2b-56": 0xB207,
    "blake2b-64": 0xB208,
    "blake2b-72": 0xB209,
    "blake2b-80": 0xB20A,
    "blake2b-88": 0xB20B,
    "blake2b-96": 0xB20C,
    "blake2b-104": 0xB20D,
    "blake2b-112": 0xB20E,
    "blake2b-120": 0xB20F,
    "blake2b-128": 0xB210,
    "blake2b-136": 0xB211,
    "blake2b-144": 0xB212,
    "blake2b-152": 0xB213,
    "blake2b-160": 0xB214,
    "blake2b-168": 0xB215,
    "blake2b-176": 0xB216,
    "blake2b-184": 0xB217,
    "blake2b-192": 0xB218,
    "blake2b-200": 0xB219,
    "blake2b-208": 0xB21A,
    "blake2b-216": 0xB21B,
    "blake2b-224": 0xB21C,
    "blake2b-232": 0xB21D,
    "blake2b-240": 0xB21E,
    "blake2b-248": 0xB21F,
    "blake2b-256": 0xB220,
    "blake2b-264": 0xB221,
    "blake2b-272": 0xB222,
    "blake2b-280": 0xB223,
    "blake2b-288": 0xB224,
    "blake2b-296": 0xB225,
    "blake2b-304": 0xB226,
    "blake2b-312": 0xB227,
    "blake2b-320": 0xB228,
    "blake2b-328": 0xB229,
    "blake2b-336": 0xB22A,
    "blake2b-344": 0xB22B,
    "blake2b-352": 0xB22C,
    "blake2b-360": 0xB22D,
    "blake2b-368": 0xB22E,
    "blake2b-376": 0xB22F,
    "blake2b-384": 0xB230,
    "blake2b-392": 0xB231,
    "blake2b-400": 0xB232,
    "blake2b-408": 0xB233,
    "blake2b-416": 0xB234,
    "blake2b-424": 0xB235,
    "blake2b-432": 0xB236,
    "blake2b-440": 0xB237,
    "blake2b-448": 0xB238,
    "blake2b-456": 0xB239,
    "blake2b-464": 0xB23A,
    "blake2b-472": 0xB23B,
    "blake2b-480": 0xB23C,
    "blake2b-488": 0xB23D,
    "blake2b-496": 0xB23E,
    "blake2b-504": 0xB23F,
    "blake2b-512": 0xB240,
    "blake2s-8": 0xB241,
    "blake2s-16": 0xB242,
    "blake2s-24": 0xB243,
    "blake2s-32": 0xB244,
    "blake2s-40": 0xB245,
    "blake2s-48": 0xB246,
    "blake2s-56": 0xB247,
    "blake2s-64": 0xB248,
    "blake2s-72": 0xB249,
    "blake2s-80": 0xB24A,
    "blake2s-88": 0xB24B,
    "blake2s-96": 0xB24C,
    "blake2s-104": 0xB24D,
    "blake2s-112": 0xB24E,
    "blake2s-120": 0xB24F,
    "blake2s-128": 0xB250,
    "blake2s-136": 0xB251,
    "blake2s-144": 0xB252,
    "blake2s-152": 0xB253,
    "blake2s-160": 0xB254,
    "blake2s-168": 0xB255,
    "blake2s-176": 0xB256,
    "blake2s-184": 0xB257,
    "blake2s-192": 0xB258,
    "blake2s-200": 0xB259,
    "blake2s-208": 0xB25A,
    "blake2s-216": 0xB25B,
    "blake2s-224": 0xB25C,
    "blake2s-232": 0xB25D,
    "blake2s-240": 0xB25E,
    "blake2s-248": 0xB25F,
    "blake2s-256": 0xB260,
    "Skein256-8": 0xB301,
    "Skein256-16": 0xB302,
    "Skein256-24": 0xB303,
    "Skein256-32": 0xB304,
    "Skein256-40": 0xB305,
    "Skein256-48": 0xB306,
    "Skein256-56": 0xB307,
    "Skein256-64": 0xB308,
    "Skein256-72": 0xB309,
    "Skein256-80": 0xB30A,
    "Skein256-88": 0xB30B,
    "Skein256-96": 0xB30C,
    "Skein256-104": 0xB30D,
    "Skein256-112": 0xB30E,
    "Skein256-120": 0xB30F,
    "Skein256-128": 0xB310,
    "Skein256-136": 0xB311,
    "Skein256-144": 0xB312,
    "Skein256-152": 0xB313,
    "Skein256-160": 0xB314,
    "Skein256-168": 0xB315,
    "Skein256-176": 0xB316,
    "Skein256-184": 0xB317,
    "Skein256-192": 0xB318,
    "Skein256-200": 0xB319,
    "Skein256-208": 0xB31A,
    "Skein256-216": 0xB31B,
    "Skein256-224": 0xB31C,
    "Skein256-232": 0xB31D,
    "Skein256-240": 0xB31E,
    "Skein256-248": 0xB31F,
    "Skein256-256": 0xB320,
    "Skein512-8": 0xB321,
    "Skein512-16": 0xB322,
    "Skein512-24": 0xB323,
    "Skein512-32": 0xB324,
    "Skein512-40": 0xB325,
    "Skein512-48": 0xB326,
    "Skein512-56": 0xB327,
    "Skein512-64": 0xB328,
    "Skein512-72": 0xB329,
    "Skein512-80": 0xB32A,
    "Skein512-88": 0xB32B,
    "Skein512-96": 0xB32C,
    "Skein512-104": 0xB32D,
    "Skein512-112": 0xB32E,
    "Skein512-120": 0xB32F,
    "Skein512-128": 0xB330,
    "Skein512-136": 0xB331,
    "Skein512-144": 0xB332,
    "Skein512-152": 0xB333,
    "Skein512-160": 0xB334,
    "Skein512-168": 0xB335,
    "Skein512-176": 0xB336,
    "Skein512-184": 0xB337,
    "Skein512-192": 0xB338,
    "Skein512-200": 0xB339,
    "Skein512-208": 0xB33A,
    "Skein512-216": 0xB33B,
    "Skein512-224": 0xB33C,
    "Skein512-232": 0xB33D,
    "Skein512-240": 0xB33E,
    "Skein512-248": 0xB33F,
    "Skein512-256": 0xB340,
    "Skein512-264": 0xB341,
    "Skein512-272": 0xB342,
    "Skein512-280": 0xB343,
    "Skein512-288": 0xB344,
    "Skein512-296": 0xB345,
    "Skein512-304": 0xB346,
    "Skein512-312": 0xB347,
    "Skein512-320": 0xB348,
    "Skein512-328": 0xB349,
    "Skein512-336": 0xB34A,
    "Skein512-344": 0xB34B,
    "Skein512-352": 0xB34C,
    "Skein512-360": 0xB34D,
    "Skein512-368": 0xB34E,
    "Skein512-376": 0xB34F,
    "Skein512-384": 0xB350,
    "Skein512-392": 0xB351,
    "Skein512-400": 0xB352,
    "Skein512-408": 0xB353,
    "Skein512-416": 0xB354,
    "Skein512-424": 0xB355,
    "Skein512-432": 0xB356,
    "Skein512-440": 0xB357,
    "Skein512-448": 0xB358,
    "Skein512-456": 0xB359,
    "Skein512-464": 0xB35A,
    "Skein512-472": 0xB35B,
    "Skein512-480": 0xB35C,
    "Skein512-488": 0xB35D,
    "Skein512-496": 0xB35E,
    "Skein512-504": 0xB35F,
    "Skein512-512": 0xB360,
    "Skein1024-8": 0xB361,
    "Skein1024-16": 0xB362,
    "Skein1024-24": 0xB363,
    "Skein1024-32": 0xB364,
    "Skein1024-40": 0xB365,
    "Skein1024-48": 0xB366,
    "Skein1024-56": 0xB367,
    "Skein1024-64": 0xB368,
    "Skein1024-72": 0xB369,
    "Skein1024-80": 0xB36A,
    "Skein1024-88": 0xB36B,
    "Skein1024-96": 0xB36C,
    "Skein1024-104": 0xB36D,
    "Skein1024-112": 0xB36E,
    "Skein1024-120": 0xB36F,
    "Skein1024-128": 0xB370,
    "Skein1024-136": 0xB371,
    "Skein1024-144": 0xB372,
    "Skein1024-152": 0xB373,
    "Skein1024-160": 0xB374,
    "Skein1024-168": 0xB375,
    "Skein1024-176": 0xB376,
    "Skein1024-184": 0xB377,
    "Skein1024-192": 0xB378,
    "Skein1024-200": 0xB379,
    "Skein1024-208": 0xB37A,
    "Skein1024-216": 0xB37B,
    "Skein1024-224": 0xB37C,
    "Skein1024-232": 0xB37D,
    "Skein1024-240": 0xB37E,
    "Skein1024-248": 0xB37F,
    "Skein1024-256": 0xB380,
    "Skein1024-264": 0xB381,
    "Skein1024-272": 0xB382,
    "Skein1024-280": 0xB383,
    "Skein1024-288": 0xB384,
    "Skein1024-296": 0xB385,
    "Skein1024-304": 0xB386,
    "Skein1024-312": 0xB387,
    "Skein1024-320": 0xB388,
    "Skein1024-328": 0xB389,
    "Skein1024-336": 0xB38A,
    "Skein1024-344": 0xB38B,
    "Skein1024-352": 0xB38C,
    "Skein1024-360": 0xB38D,
    "Skein1024-368": 0xB38E,
    "Skein1024-376": 0xB38F,
    "Skein1024-384": 0xB390,
    "Skein1024-392": 0xB391,
    "Skein1024-400": 0xB392,
    "Skein1024-408": 0xB393,
    "Skein1024-416": 0xB394,
    "Skein1024-424": 0xB395,
    "Skein1024-432": 0xB396,
    "Skein1024-440": 0xB397,
    "Skein1024-448": 0xB398,
    "Skein1024-456": 0xB399,
    "Skein1024-464": 0xB39A,
    "Skein1024-472": 0xB39B,
    "Skein1024-480": 0xB39C,
    "Skein1024-488": 0xB39D,
    "Skein1024-496": 0xB39E,
    "Skein1024-504": 0xB39F,
    "Skein1024-512": 0xB3A0,
    "Skein1024-520": 0xB3A1,
    "Skein1024-528": 0xB3A2,
    "Skein1024-536": 0xB3A3,
    "Skein1024-544": 0xB3A4,
    "Skein1024-552": 0xB3A5,
    "Skein1024-560": 0xB3A6,
    "Skein1024-568": 0xB3A7,
    "Skein1024-576": 0xB3A8,
    "Skein1024-584": 0xB3A9,
    "Skein1024-592": 0xB3AA,
    "Skein1024-600": 0xB3AB,
    "Skein1024-608": 0xB3AC,
    "Skein1024-616": 0xB3AD,
    "Skein1024-624": 0xB3AE,
    "Skein1024-632": 0xB3AF,
    "Skein1024-640": 0xB3B0,
    "Skein1024-648": 0xB3B1,
    "Skein1024-656": 0xB3B2,
    "Skein1024-664": 0xB3B3,
    "Skein1024-672": 0xB3B4,
    "Skein1024-680": 0xB3B5,
    "Skein1024-688": 0xB3B6,
    "Skein1024-696": 0xB3B7,
    "Skein1024-704": 0xB3B8,
    "Skein1024-712": 0xB3B9,
    "Skein1024-720": 0xB3BA,
    "Skein1024-728": 0xB3BB,
    "Skein1024-736": 0xB3BC,
    "Skein1024-744": 0xB3BD,
    "Skein1024-752": 0xB3BE,
    "Skein1024-760": 0xB3BF,
    "Skein1024-768": 0xB3C0,
    "Skein1024-776": 0xB3C1,
    "Skein1024-784": 0xB3C2,
    "Skein1024-792": 0xB3C3,
    "Skein1024-800": 0xB3C4,
    "Skein1024-808": 0xB3C5,
    "Skein1024-816": 0xB3C6,
    "Skein1024-824": 0xB3C7,
    "Skein1024-832": 0xB3C8,
    "Skein1024-840": 0xB3C9,
    "Skein1024-848": 0xB3CA,
    "Skein1024-856": 0xB3CB,
    "Skein1024-864": 0xB3CC,
    "Skein1024-872": 0xB3CD,
    "Skein1024-880": 0xB3CE,
    "Skein1024-888": 0xB3CF,
    "Skein1024-896": 0xB3D0,
    "Skein1024-904": 0xB3D1,
    "Skein1024-912": 0xB3D2,
    "Skein1024-920": 0xB3D3,
    "Skein1024-928": 0xB3D4,
    "Skein1024-936": 0xB3D5,
    "Skein1024-944": 0xB3D6,
    "Skein1024-952": 0xB3D7,
    "Skein1024-960": 0xB3D8,
    "Skein1024-968": 0xB3D9,
    "Skein1024-976": 0xB3DA,
    "Skein1024-984": 0xB3DB,
    "Skein1024-992": 0xB3DC,
    "Skein1024-1000": 0xB3DD,
    "Skein1024-1008": 0xB3DE,
    "Skein1024-1016": 0xB3DF,
    "Skein1024-1024": 0xB3E0,
}

codes = {
    0xD5: "md5",
    0x11: "sha1",
    0x12: "sha2-256",
    0x13: "sha2-512",
    0x56: "dbl-sha2-256",
    0x17: "sha3-224",
    0x16: "sha3-256",
    0x15: "sha3-384",
    0x14: "sha3-512",
    0x18: "shake-128",
    0x19: "shake-256",
    0x1A: "keccak-224",
    0x1B: "keccak-256",
    0x1C: "keccak-384",
    0x1D: "keccak-512",
    0x22: "murmur3-128",
    0x23: "murmur3-32",
    # blake2
    0xB201: "blake2b-8",
    0xB202: "blake2b-16",
    0xB203: "blake2b-24",
    0xB204: "blake2b-32",
    0xB205: "blake2b-40",
    0xB206: "blake2b-48",
    0xB207: "blake2b-56",
    0xB208: "blake2b-64",
    0xB209: "blake2b-72",
    0xB20A: "blake2b-80",
    0xB20B: "blake2b-88",
    0xB20C: "blake2b-96",
    0xB20D: "blake2b-104",
    0xB20E: "blake2b-112",
    0xB20F: "blake2b-120",
    0xB210: "blake2b-128",
    0xB211: "blake2b-136",
    0xB212: "blake2b-144",
    0xB213: "blake2b-152",
    0xB214: "blake2b-160",
    0xB215: "blake2b-168",
    0xB216: "blake2b-176",
    0xB217: "blake2b-184",
    0xB218: "blake2b-192",
    0xB219: "blake2b-200",
    0xB21A: "blake2b-208",
    0xB21B: "blake2b-216",
    0xB21C: "blake2b-224",
    0xB21D: "blake2b-232",
    0xB21E: "blake2b-240",
    0xB21F: "blake2b-248",
    0xB220: "blake2b-256",
    0xB221: "blake2b-264",
    0xB222: "blake2b-272",
    0xB223: "blake2b-280",
    0xB224: "blake2b-288",
    0xB225: "blake2b-296",
    0xB226: "blake2b-304",
    0xB227: "blake2b-312",
    0xB228: "blake2b-320",
    0xB229: "blake2b-328",
    0xB22A: "blake2b-336",
    0xB22B: "blake2b-344",
    0xB22C: "blake2b-352",
    0xB22D: "blake2b-360",
    0xB22E: "blake2b-368",
    0xB22F: "blake2b-376",
    0xB230: "blake2b-384",
    0xB231: "blake2b-392",
    0xB232: "blake2b-400",
    0xB233: "blake2b-408",
    0xB234: "blake2b-416",
    0xB235: "blake2b-424",
    0xB236: "blake2b-432",
    0xB237: "blake2b-440",
    0xB238: "blake2b-448",
    0xB239: "blake2b-456",
    0xB23A: "blake2b-464",
    0xB23B: "blake2b-472",
    0xB23C: "blake2b-480",
    0xB23D: "blake2b-488",
    0xB23E: "blake2b-496",
    0xB23F: "blake2b-504",
    0xB240: "blake2b-512",
    0xB241: "blake2s-8",
    0xB242: "blake2s-16",
    0xB243: "blake2s-24",
    0xB244: "blake2s-32",
    0xB245: "blake2s-40",
    0xB246: "blake2s-48",
    0xB247: "blake2s-56",
    0xB248: "blake2s-64",
    0xB249: "blake2s-72",
    0xB24A: "blake2s-80",
    0xB24B: "blake2s-88",
    0xB24C: "blake2s-96",
    0xB24D: "blake2s-104",
    0xB24E: "blake2s-112",
    0xB24F: "blake2s-120",
    0xB250: "blake2s-128",
    0xB251: "blake2s-136",
    0xB252: "blake2s-144",
    0xB253: "blake2s-152",
    0xB254: "blake2s-160",
    0xB255: "blake2s-168",
    0xB256: "blake2s-176",
    0xB257: "blake2s-184",
    0xB258: "blake2s-192",
    0xB259: "blake2s-200",
    0xB25A: "blake2s-208",
    0xB25B: "blake2s-216",
    0xB25C: "blake2s-224",
    0xB25D: "blake2s-232",
    0xB25E: "blake2s-240",
    0xB25F: "blake2s-248",
    0xB260: "blake2s-256",
    # skein
    0xB301: "Skein256-8",
    0xB302: "Skein256-16",
    0xB303: "Skein256-24",
    0xB304: "Skein256-32",
    0xB305: "Skein256-40",
    0xB306: "Skein256-48",
    0xB307: "Skein256-56",
    0xB308: "Skein256-64",
    0xB309: "Skein256-72",
    0xB30A: "Skein256-80",
    0xB30B: "Skein256-88",
    0xB30C: "Skein256-96",
    0xB30D: "Skein256-104",
    0xB30E: "Skein256-112",
    0xB30F: "Skein256-120",
    0xB310: "Skein256-128",
    0xB311: "Skein256-136",
    0xB312: "Skein256-144",
    0xB313: "Skein256-152",
    0xB314: "Skein256-160",
    0xB315: "Skein256-168",
    0xB316: "Skein256-176",
    0xB317: "Skein256-184",
    0xB318: "Skein256-192",
    0xB319: "Skein256-200",
    0xB31A: "Skein256-208",
    0xB31B: "Skein256-216",
    0xB31C: "Skein256-224",
    0xB31D: "Skein256-232",
    0xB31E: "Skein256-240",
    0xB31F: "Skein256-248",
    0xB320: "Skein256-256",
    0xB321: "Skein512-8",
    0xB322: "Skein512-16",
    0xB323: "Skein512-24",
    0xB324: "Skein512-32",
    0xB325: "Skein512-40",
    0xB326: "Skein512-48",
    0xB327: "Skein512-56",
    0xB328: "Skein512-64",
    0xB329: "Skein512-72",
    0xB32A: "Skein512-80",
    0xB32B: "Skein512-88",
    0xB32C: "Skein512-96",
    0xB32D: "Skein512-104",
    0xB32E: "Skein512-112",
    0xB32F: "Skein512-120",
    0xB330: "Skein512-128",
    0xB331: "Skein512-136",
    0xB332: "Skein512-144",
    0xB333: "Skein512-152",
    0xB334: "Skein512-160",
    0xB335: "Skein512-168",
    0xB336: "Skein512-176",
    0xB337: "Skein512-184",
    0xB338: "Skein512-192",
    0xB339: "Skein512-200",
    0xB33A: "Skein512-208",
    0xB33B: "Skein512-216",
    0xB33C: "Skein512-224",
    0xB33D: "Skein512-232",
    0xB33E: "Skein512-240",
    0xB33F: "Skein512-248",
    0xB340: "Skein512-256",
    0xB341: "Skein512-264",
    0xB342: "Skein512-272",
    0xB343: "Skein512-280",
    0xB344: "Skein512-288",
    0xB345: "Skein512-296",
    0xB346: "Skein512-304",
    0xB347: "Skein512-312",
    0xB348: "Skein512-320",
    0xB349: "Skein512-328",
    0xB34A: "Skein512-336",
    0xB34B: "Skein512-344",
    0xB34C: "Skein512-352",
    0xB34D: "Skein512-360",
    0xB34E: "Skein512-368",
    0xB34F: "Skein512-376",
    0xB350: "Skein512-384",
    0xB351: "Skein512-392",
    0xB352: "Skein512-400",
    0xB353: "Skein512-408",
    0xB354: "Skein512-416",
    0xB355: "Skein512-424",
    0xB356: "Skein512-432",
    0xB357: "Skein512-440",
    0xB358: "Skein512-448",
    0xB359: "Skein512-456",
    0xB35A: "Skein512-464",
    0xB35B: "Skein512-472",
    0xB35C: "Skein512-480",
    0xB35D: "Skein512-488",
    0xB35E: "Skein512-496",
    0xB35F: "Skein512-504",
    0xB360: "Skein512-512",
    0xB361: "Skein1024-8",
    0xB362: "Skein1024-16",
    0xB363: "Skein1024-24",
    0xB364: "Skein1024-32",
    0xB365: "Skein1024-40",
    0xB366: "Skein1024-48",
    0xB367: "Skein1024-56",
    0xB368: "Skein1024-64",
    0xB369: "Skein1024-72",
    0xB36A: "Skein1024-80",
    0xB36B: "Skein1024-88",
    0xB36C: "Skein1024-96",
    0xB36D: "Skein1024-104",
    0xB36E: "Skein1024-112",
    0xB36F: "Skein1024-120",
    0xB370: "Skein1024-128",
    0xB371: "Skein1024-136",
    0xB372: "Skein1024-144",
    0xB373: "Skein1024-152",
    0xB374: "Skein1024-160",
    0xB375: "Skein1024-168",
    0xB376: "Skein1024-176",
    0xB377: "Skein1024-184",
    0xB378: "Skein1024-192",
    0xB379: "Skein1024-200",
    0xB37A: "Skein1024-208",
    0xB37B: "Skein1024-216",
    0xB37C: "Skein1024-224",
    0xB37D: "Skein1024-232",
    0xB37E: "Skein1024-240",
    0xB37F: "Skein1024-248",
    0xB380: "Skein1024-256",
    0xB381: "Skein1024-264",
    0xB382: "Skein1024-272",
    0xB383: "Skein1024-280",
    0xB384: "Skein1024-288",
    0xB385: "Skein1024-296",
    0xB386: "Skein1024-304",
    0xB387: "Skein1024-312",
    0xB388: "Skein1024-320",
    0xB389: "Skein1024-328",
    0xB38A: "Skein1024-336",
    0xB38B: "Skein1024-344",
    0xB38C: "Skein1024-352",
    0xB38D: "Skein1024-360",
    0xB38E: "Skein1024-368",
    0xB38F: "Skein1024-376",
    0xB390: "Skein1024-384",
    0xB391: "Skein1024-392",
    0xB392: "Skein1024-400",
    0xB393: "Skein1024-408",
    0xB394: "Skein1024-416",
    0xB395: "Skein1024-424",
    0xB396: "Skein1024-432",
    0xB397: "Skein1024-440",
    0xB398: "Skein1024-448",
    0xB399: "Skein1024-456",
    0xB39A: "Skein1024-464",
    0xB39B: "Skein1024-472",
    0xB39C: "Skein1024-480",
    0xB39D: "Skein1024-488",
    0xB39E: "Skein1024-496",
    0xB39F: "Skein1024-504",
    0xB3A0: "Skein1024-512",
    0xB3A1: "Skein1024-520",
    0xB3A2: "Skein1024-528",
    0xB3A3: "Skein1024-536",
    0xB3A4: "Skein1024-544",
    0xB3A5: "Skein1024-552",
    0xB3A6: "Skein1024-560",
    0xB3A7: "Skein1024-568",
    0xB3A8: "Skein1024-576",
    0xB3A9: "Skein1024-584",
    0xB3AA: "Skein1024-592",
    0xB3AB: "Skein1024-600",
    0xB3AC: "Skein1024-608",
    0xB3AD: "Skein1024-616",
    0xB3AE: "Skein1024-624",
    0xB3AF: "Skein1024-632",
    0xB3B0: "Skein1024-640",
    0xB3B1: "Skein1024-648",
    0xB3B2: "Skein1024-656",
    0xB3B3: "Skein1024-664",
    0xB3B4: "Skein1024-672",
    0xB3B5: "Skein1024-680",
    0xB3B6: "Skein1024-688",
    0xB3B7: "Skein1024-696",
    0xB3B8: "Skein1024-704",
    0xB3B9: "Skein1024-712",
    0xB3BA: "Skein1024-720",
    0xB3BB: "Skein1024-728",
    0xB3BC: "Skein1024-736",
    0xB3BD: "Skein1024-744",
    0xB3BE: "Skein1024-752",
    0xB3BF: "Skein1024-760",
    0xB3C0: "Skein1024-768",
    0xB3C1: "Skein1024-776",
    0xB3C2: "Skein1024-784",
    0xB3C3: "Skein1024-792",
    0xB3C4: "Skein1024-800",
    0xB3C5: "Skein1024-808",
    0xB3C6: "Skein1024-816",
    0xB3C7: "Skein1024-824",
    0xB3C8: "Skein1024-832",
    0xB3C9: "Skein1024-840",
    0xB3CA: "Skein1024-848",
    0xB3CB: "Skein1024-856",
    0xB3CC: "Skein1024-864",
    0xB3CD: "Skein1024-872",
    0xB3CE: "Skein1024-880",
    0xB3CF: "Skein1024-888",
    0xB3D0: "Skein1024-896",
    0xB3D1: "Skein1024-904",
    0xB3D2: "Skein1024-912",
    0xB3D3: "Skein1024-920",
    0xB3D4: "Skein1024-928",
    0xB3D5: "Skein1024-936",
    0xB3D6: "Skein1024-944",
    0xB3D7: "Skein1024-952",
    0xB3D8: "Skein1024-960",
    0xB3D9: "Skein1024-968",
    0xB3DA: "Skein1024-976",
    0xB3DB: "Skein1024-984",
    0xB3DC: "Skein1024-992",
    0xB3DD: "Skein1024-1000",
    0xB3DE: "Skein1024-1008",
    0xB3DF: "Skein1024-1016",
    0xB3E0: "Skein1024-1024",
}

default_lengths = {
    0xD5: 16,
    0x11: 20,
    0x12: 32,
    0x13: 64,
    0x56: 32,
    0x17: 28,
    0x16: 32,
    0x15: 48,
    0x14: 64,
    0x18: 32,
    0x19: 64,
    0x1A: 28,
    0x1B: 32,
    0x1C: 48,
    0x1D: 64,
    0x22: 32,
    0xB201: 0x01,
    0xB202: 0x02,
    0xB203: 0x03,
    0xB204: 0x04,
    0xB205: 0x05,
    0xB206: 0x06,
    0xB207: 0x07,
    0xB208: 0x08,
    0xB209: 0x09,
    0xB20A: 0x0A,
    0xB20B: 0x0B,
    0xB20C: 0x0C,
    0xB20D: 0x0D,
    0xB20E: 0x0E,
    0xB20F: 0x0F,
    0xB210: 0x10,
    0xB211: 0x11,
    0xB212: 0x12,
    0xB213: 0x13,
    0xB214: 0x14,
    0xB215: 0x15,
    0xB216: 0x16,
    0xB217: 0x17,
    0xB218: 0x18,
    0xB219: 0x19,
    0xB21A: 0x1A,
    0xB21B: 0x1B,
    0xB21C: 0x1C,
    0xB21D: 0x1D,
    0xB21E: 0x1E,
    0xB21F: 0x1F,
    0xB220: 0x20,
    0xB221: 0x21,
    0xB222: 0x22,
    0xB223: 0x23,
    0xB224: 0x24,
    0xB225: 0x25,
    0xB226: 0x26,
    0xB227: 0x27,
    0xB228: 0x28,
    0xB229: 0x29,
    0xB22A: 0x2A,
    0xB22B: 0x2B,
    0xB22C: 0x2C,
    0xB22D: 0x2D,
    0xB22E: 0x2E,
    0xB22F: 0x2F,
    0xB230: 0x30,
    0xB231: 0x31,
    0xB232: 0x32,
    0xB233: 0x33,
    0xB234: 0x34,
    0xB235: 0x35,
    0xB236: 0x36,
    0xB237: 0x37,
    0xB238: 0x38,
    0xB239: 0x39,
    0xB23A: 0x3A,
    0xB23B: 0x3B,
    0xB23C: 0x3C,
    0xB23D: 0x3D,
    0xB23E: 0x3E,
    0xB23F: 0x3F,
    0xB240: 0x40,
    0xB241: 0x01,
    0xB242: 0x02,
    0xB243: 0x03,
    0xB244: 0x04,
    0xB245: 0x05,
    0xB246: 0x06,
    0xB247: 0x07,
    0xB248: 0x08,
    0xB249: 0x09,
    0xB24A: 0x0A,
    0xB24B: 0x0B,
    0xB24C: 0x0C,
    0xB24D: 0x0D,
    0xB24E: 0x0E,
    0xB24F: 0x0F,
    0xB250: 0x10,
    0xB251: 0x11,
    0xB252: 0x12,
    0xB253: 0x13,
    0xB254: 0x14,
    0xB255: 0x15,
    0xB256: 0x16,
    0xB257: 0x17,
    0xB258: 0x18,
    0xB259: 0x19,
    0xB25A: 0x1A,
    0xB25B: 0x1B,
    0xB25C: 0x1C,
    0xB25D: 0x1D,
    0xB25E: 0x1E,
    0xB25F: 0x1F,
    0xB260: 0x20,
    0xB301: 0x01,
    0xB302: 0x02,
    0xB303: 0x03,
    0xB304: 0x04,
    0xB305: 0x05,
    0xB306: 0x06,
    0xB307: 0x07,
    0xB308: 0x08,
    0xB309: 0x09,
    0xB30A: 0x0A,
    0xB30B: 0x0B,
    0xB30C: 0x0C,
    0xB30D: 0x0D,
    0xB30E: 0x0E,
    0xB30F: 0x0F,
    0xB310: 0x10,
    0xB311: 0x11,
    0xB312: 0x12,
    0xB313: 0x13,
    0xB314: 0x14,
    0xB315: 0x15,
    0xB316: 0x16,
    0xB317: 0x17,
    0xB318: 0x18,
    0xB319: 0x19,
    0xB31A: 0x1A,
    0xB31B: 0x1B,
    0xB31C: 0x1C,
    0xB31D: 0x1D,
    0xB31E: 0x1E,
    0xB31F: 0x1F,
    0xB320: 0x20,
    0xB321: 0x01,
    0xB322: 0x02,
    0xB323: 0x03,
    0xB324: 0x04,
    0xB325: 0x05,
    0xB326: 0x06,
    0xB327: 0x07,
    0xB328: 0x08,
    0xB329: 0x09,
    0xB32A: 0x0A,
    0xB32B: 0x0B,
    0xB32C: 0x0C,
    0xB32D: 0x0D,
    0xB32E: 0x0E,
    0xB32F: 0x0F,
    0xB330: 0x10,
    0xB331: 0x11,
    0xB332: 0x12,
    0xB333: 0x13,
    0xB334: 0x14,
    0xB335: 0x15,
    0xB336: 0x16,
    0xB337: 0x17,
    0xB338: 0x18,
    0xB339: 0x19,
    0xB33A: 0x1A,
    0xB33B: 0x1B,
    0xB33C: 0x1C,
    0xB33D: 0x1D,
    0xB33E: 0x1E,
    0xB33F: 0x1F,
    0xB340: 0x20,
    0xB341: 0x21,
    0xB342: 0x22,
    0xB343: 0x23,
    0xB344: 0x24,
    0xB345: 0x25,
    0xB346: 0x26,
    0xB347: 0x27,
    0xB348: 0x28,
    0xB349: 0x29,
    0xB34A: 0x2A,
    0xB34B: 0x2B,
    0xB34C: 0x2C,
    0xB34D: 0x2D,
    0xB34E: 0x2E,
    0xB34F: 0x2F,
    0xB350: 0x30,
    0xB351: 0x31,
    0xB352: 0x32,
    0xB353: 0x33,
    0xB354: 0x34,
    0xB355: 0x35,
    0xB356: 0x36,
    0xB357: 0x37,
    0xB358: 0x38,
    0xB359: 0x39,
    0xB35A: 0x3A,
    0xB35B: 0x3B,
    0xB35C: 0x3C,
    0xB35D: 0x3D,
    0xB35E: 0x3E,
    0xB35F: 0x3F,
    0xB360: 0x40,
    0xB361: 0x01,
    0xB362: 0x02,
    0xB363: 0x03,
    0xB364: 0x04,
    0xB365: 0x05,
    0xB366: 0x06,
    0xB367: 0x07,
    0xB368: 0x08,
    0xB369: 0x09,
    0xB36A: 0x0A,
    0xB36B: 0x0B,
    0xB36C: 0x0C,
    0xB36D: 0x0D,
    0xB36E: 0x0E,
    0xB36F: 0x0F,
    0xB370: 0x10,
    0xB371: 0x11,
    0xB372: 0x12,
    0xB373: 0x13,
    0xB374: 0x14,
    0xB375: 0x15,
    0xB376: 0x16,
    0xB377: 0x17,
    0xB378: 0x18,
    0xB379: 0x19,
    0xB37A: 0x1A,
    0xB37B: 0x1B,
    0xB37C: 0x1C,
    0xB37D: 0x1D,
    0xB37E: 0x1E,
    0xB37F: 0x1F,
    0xB380: 0x20,
    0xB381: 0x21,
    0xB382: 0x22,
    0xB383: 0x23,
    0xB384: 0x24,
    0xB385: 0x25,
    0xB386: 0x26,
    0xB387: 0x27,
    0xB388: 0x28,
    0xB389: 0x29,
    0xB38A: 0x2A,
    0xB38B: 0x2B,
    0xB38C: 0x2C,
    0xB38D: 0x2D,
    0xB38E: 0x2E,
    0xB38F: 0x2F,
    0xB390: 0x30,
    0xB391: 0x31,
    0xB392: 0x32,
    0xB393: 0x33,
    0xB394: 0x34,
    0xB395: 0x35,
    0xB396: 0x36,
    0xB397: 0x37,
    0xB398: 0x38,
    0xB399: 0x39,
    0xB39A: 0x3A,
    0xB39B: 0x3B,
    0xB39C: 0x3C,
    0xB39D: 0x3D,
    0xB39E: 0x3E,
    0xB39F: 0x3F,
    0xB3A0: 0x40,
    0xB3A1: 0x41,
    0xB3A2: 0x42,
    0xB3A3: 0x43,
    0xB3A4: 0x44,
    0xB3A5: 0x45,
    0xB3A6: 0x46,
    0xB3A7: 0x47,
    0xB3A8: 0x48,
    0xB3A9: 0x49,
    0xB3AA: 0x4A,
    0xB3AB: 0x4B,
    0xB3AC: 0x4C,
    0xB3AD: 0x4D,
    0xB3AE: 0x4E,
    0xB3AF: 0x4F,
    0xB3B0: 0x50,
    0xB3B1: 0x51,
    0xB3B2: 0x52,
    0xB3B3: 0x53,
    0xB3B4: 0x54,
    0xB3B5: 0x55,
    0xB3B6: 0x56,
    0xB3B7: 0x57,
    0xB3B8: 0x58,
    0xB3B9: 0x59,
    0xB3BA: 0x5A,
    0xB3BB: 0x5B,
    0xB3BC: 0x5C,
    0xB3BD: 0x5D,
    0xB3BE: 0x5E,
    0xB3BF: 0x5F,
    0xB3C0: 0x60,
    0xB3C1: 0x61,
    0xB3C2: 0x62,
    0xB3C3: 0x63,
    0xB3C4: 0x64,
    0xB3C5: 0x65,
    0xB3C6: 0x66,
    0xB3C7: 0x67,
    0xB3C8: 0x68,
    0xB3C9: 0x69,
    0xB3CA: 0x6A,
    0xB3CB: 0x6B,
    0xB3CC: 0x6C,
    0xB3CD: 0x6D,
    0xB3CE: 0x6E,
    0xB3CF: 0x6F,
    0xB3D0: 0x70,
    0xB3D1: 0x71,
    0xB3D2: 0x72,
    0xB3D3: 0x73,
    0xB3D4: 0x74,
    0xB3D5: 0x75,
    0xB3D6: 0x76,
    0xB3D7: 0x77,
    0xB3D8: 0x78,
    0xB3D9: 0x79,
    0xB3DA: 0x7A,
    0xB3DB: 0x7B,
    0xB3DC: 0x7C,
    0xB3DD: 0x7D,
    0xB3DE: 0x7E,
    0xB3DF: 0x7F,
    0xB3E0: 0x80,
}


class CONTRACT_TYPES(Enum):
    USER_FACTORY = "user_factory"
    TRACK_FACTORY = "track_factory"
    SOCIAL_FEATURE_FACTORY = "social_feature_factory"
    PLAYLIST_FACTORY = "playlist_factory"
    USER_LIBRARY_FACTORY = "user_library_factory"
    USER_REPLICA_SET_MANAGER = "user_replica_set_manager"


CONTRACT_NAMES_ON_CHAIN = {
    CONTRACT_TYPES.USER_FACTORY: "UserFactory",
    CONTRACT_TYPES.TRACK_FACTORY: "TrackFactory",
    CONTRACT_TYPES.SOCIAL_FEATURE_FACTORY: "SocialFeatureFactory",
    CONTRACT_TYPES.PLAYLIST_FACTORY: "PlaylistFactory",
    CONTRACT_TYPES.USER_LIBRARY_FACTORY: "UserLibraryFactory",
    CONTRACT_TYPES.USER_REPLICA_SET_MANAGER: "UserReplicaSetManager",
}
