CPU_CYCLE_MS = 1024
PROG_OFFSET = 0x100

# unused
SCREEN_RAM_POS = 0x300
SCREEN_WIDTH = 40
SCREEN_HEIGHT = 12


import sys
import os
import argparse

parser = argparse.ArgumentParser(description='Transpile 8086 binary to CSS')
parser.add_argument('input', nargs='?', default='program.bin', help='Input binary file')
parser.add_argument('--mem', type=lambda x: int(x, 0), default=0x600, help='Writable memory size (hex ok, e.g. 0x6000)')
parser.add_argument('--data', nargs=2, action='append', metavar=('ADDR', 'FILE'),
                    help='Embed binary file at address (read-only). Can be repeated. e.g. --data 0xC000 zork1.dat')
parser.add_argument('--html', action='store_true',
                    help='Output self-contained HTML with visualisation (default: CSS only)')
args = parser.parse_args()

INPUT_BIN = args.input
OUTPUT_EXT = ".html" if args.html else ".css"
OUTPUT_FILE = os.path.splitext(os.path.basename(INPUT_BIN))[0] + OUTPUT_EXT
MEM_SIZE = args.mem

# Parse --data arguments into list of (address, filepath, bytes)
embedded_data = []
if args.data:
    for addr_str, filepath in args.data:
        addr = int(addr_str, 0)
        with open(filepath, 'rb') as df:
            file_bytes = df.read()
        embedded_data.append((addr, filepath, file_bytes))
        print(f"Embedding {filepath} ({len(file_bytes)} bytes) at 0x{addr:X}")

epic_charset = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" + \
' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~' + \
'X'*141


epic_charset = [x for x in epic_charset]
epic_charset[0] = ""
epic_charset[0x0a] = "\\a "
epic_charset[ord('"')] = "\\\""
epic_charset[ord('\\')] = "\\\\"
epic_charset[0x80] = "🐴"
epic_charset[0x81] = "⬛"
epic_charset[0x82] = "🟨"
epic_charset[0x83] = "🟩"
epic_charset[0x84] = "░"
epic_charset[0x85] = "█"

import json
with open("x86-instructions-rebane.json", "r") as f:
  all_insts = json.load(f)


variables = [
    #["frame-count", "& + 1"]
    #["frame-count", "& + 1", 9007199254740991]
    ["frame-count", "& + 1", "0", True],
    #["cpu-phase", "mod(& + 1, 3)", "0", True],
    #["current-register", "(& * var(--cpu-hase))", "0", True],
    #["val", "mod(& + 100, 69)", "0", True],
    #["addrDest", "& + 1", "0", True],
]

def createChosenMemoryInt(name,i,render,chosen):
  return [f"{name}", f"if(style(--addrDestA:{i}):var(--addrValA1);"+ (f"style(--addrDestA:{i-1}) and style(--isWordWrite:1):var(--addrValA2);" if i > 0 else "") + f"style(--addrDestB:{i}):var(--addrValB);else:var(--__1{name}))", str(chosen), render];
def createEmptyInt(name,i,render):
  return [f"{name}", f"if(style(--addrDestA:{i}):var(--addrValA);style(--addrDestB:{i}):var(--addrValB);else:var(--__1{name}))", "0", render];
def createSplitRegister(name,i,render):
  return [f"{name}", f"if(" +\
  (f"style(--__1IP:{0x2006}):var(--keyboard, 0);" if name == "AX" else "") +\
  f"style(--addrDestA:{i}):var(--addrValA);style(--addrDestB:{i}):var(--addrValB);"
  f"style(--addrDestA:{i-20}):calc(var(--addrValA) * 256 + --lowerBytes(var(--__1{name}), 8));"
  f"style(--addrDestB:{i-20}):calc(var(--addrValB) * 256 + --lowerBytes(var(--__1{name}), 8));"
  f"style(--addrDestA:{i-30}):calc(round(down, var(--__1{name}) / 256) * 256 + --lowerBytes(var(--addrValA), 8));"
  f"style(--addrDestB:{i-30}):calc(round(down, var(--__1{name}) / 256) * 256 + --lowerBytes(var(--addrValB), 8));"
  #f"style(--addrDestA:{i-30}):calc(--leftShift(--rightShift(var(--__1{name}), 8), 8) + --lowerBytes(var(--addrValA), 8));"
  #f"style(--addrDestB:{i-30}):calc(--leftShift(--rightShift(var(--__1{name}), 8), 8) + --lowerBytes(var(--addrValB), 8));"
  f"else:var(--__1{name}))", "0", render];
"""

AX: -1 (AH: -21)
CX: -2 (CH: -22)
DX: -3 (DH: -23)
BX: -4 (BH: -24)

SP: -5
BP: -6
SI: -7
DI: -8

IP: -9

ES: -10
CS: -11
SS: -12
DS: -13

flags: -14
"""


START_FILE = os.path.splitext(INPUT_BIN)[0] + ".start"
if os.path.exists(START_FILE):
  with open(START_FILE, "r") as f:
    CODE_START = PROG_OFFSET + int(f.read())
else:
  CODE_START = PROG_OFFSET

variables.append(createSplitRegister(f"AX", -1, True))
variables.append(createSplitRegister(f"CX", -2, True))
variables.append(createSplitRegister(f"DX", -3, True))
variables.append(createSplitRegister(f"BX", -4, True))

variables.append([f"SP", f"if(style(--addrDestA:-5):var(--addrValA);style(--addrDestB:-5):var(--addrValB);else:calc(var(--__1SP) + var(--moveStack)))", str(MEM_SIZE-0x8), True])
variables.append(createEmptyInt(f"BP", -6, True))
variables.append([f"SI", f"if(style(--addrDestA:-7):var(--addrValA);style(--addrDestB:-7):var(--addrValB);else:calc(var(--__1SI) + var(--moveSI)))", "0", True])
variables.append([f"DI", f"if(style(--addrDestA:-8):var(--addrValA);style(--addrDestB:-8):var(--addrValB);else:calc(var(--__1DI) + var(--moveDI)))", "0", True])
#variables.append(createEmptyInt(f"SP", -8, True))

variables.append([f"IP", f"if(style(--addrDestA:-9):var(--addrValA);style(--addrDestB:-9):var(--addrValB);style(--addrJump:-1):calc(var(--__1IP) + var(--instLen));else:var(--addrJump))", str(CODE_START), True])

variables.append(createEmptyInt(f"ES", -10, True))
variables.append([f"CS", f"if(style(--addrDestA:-11):var(--addrValA);style(--addrDestB:-11):var(--addrValB);else:var(--jumpCS))", "0", True])
variables.append(createEmptyInt(f"SS", -12, True))
variables.append(createEmptyInt(f"DS", -13, True))

#variables.append(createEmptyInt(f"flags", -14, True))
variables.append([f"flags", f"if(style(--addrDestA:-14):var(--addrValA);style(--addrDestB:-14):var(--addrValB);else:var(--newFlags))", "0", True])

# did you know! i was originally planning on making this for moxie instead of x86
#variables.append(createEmptyInt(f"fp", -1, True))
#variables.append([f"sp", f"if(style(--addrDest:-2):var(--addrVal);else:var(--__1sp))", "5000", True])

var_offset = len(variables)

for i in range(MEM_SIZE):
  variables.append(createChosenMemoryInt(f"m{i}", i, True, 0x90 if i < PROG_OFFSET else 0))
variables[0x0+var_offset][2] = str(0xCC)

EXTERNAL_FUNCTIONS_START = 0x2000
EXTERNAL_FUNCTIONS_END = 0x2010
EXTFUNS = {
  "writeChar1": [0x2000, 2],
  "writeChar4": [0x2002, 2],
  "writeChar8": [0x2004, 2],
  "readInput": [0x2006, 0],
  # "writeStr": 0x2002,
}

EXTERNAL_IO_START = 0x2100
EXTERNAL_IO_END = 0x2110

for i in range(EXTERNAL_FUNCTIONS_START,EXTERNAL_FUNCTIONS_END):
  target_loc = var_offset+i
  if target_loc >= len(variables):
    variables.append(createChosenMemoryInt(f"m{i}", i, True, 0xc3))# if i != 0x2002 else 0xcc))
  else:
    variables[target_loc][2] = str(0xc3)

for i in range(EXTERNAL_IO_START,EXTERNAL_IO_END):
  target_loc = var_offset+i
  if target_loc >= len(variables):
    variables.append(createChosenMemoryInt(f"m{i}", i, True, 0x00))# if i != 0x2002 else 0xcc))
  else:
    variables[target_loc][2] = str(0x00)

EXTIO = {
  "SHOW_KEYBOARD": [0x2100, None],
}

for k,v in EXTIO.items():
  if not v[1]:
    continue
  for x in variables:
    if x[0] == f"m{v[0]}":
      x[1] = v[1]
      break

program_start = PROG_OFFSET+var_offset
with open(INPUT_BIN, "rb") as f:
  program = f.read()
  program_size = len(program)
  for i,b in enumerate(program):
    variables[program_start+i][2] = str(b)

variables_rw = variables[:program_start] + variables[program_start+program_size:]
variables_ro = variables[program_start:program_start+program_size]
#variables_rw = variables
#variables_ro = []

# Embedded data files (read-only memory regions)
# These get @property decls and readMem entries but no write expressions.
embedded_vars = []  # [(name, address, byte_value), ...]
for base_addr, filepath, file_bytes in embedded_data:
    for offset, byte_val in enumerate(file_bytes):
        addr = base_addr + offset
        embedded_vars.append((f"d{addr}", addr, byte_val))

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if args.html:
  with open(os.path.join(SCRIPT_DIR, "base_template.html"), "r") as f:
    TEMPL = f.read()
else:
  with open(os.path.join(SCRIPT_DIR, "base_template.css"), "r") as f:
    TEMPL = f.read()

for k,v in EXTFUNS.items():
  TEMPL = TEMPL.replace(f"#{k}", str(v[0]))

args_list = [
None,  # 00
# Argument Addressing Codes
"Ap",  # 01

"Eb",  # 02
"Ev",  # 03
"Ew",  # 04

"Gb",  # 05
"Gv",  # 06

"I0",  # 07
"Ib",  # 08
"Iv",  # 09
"Iw",  # 10

"Jb",  # 11
"Jv",  # 12

"Mp",  # 13

"Ob",  # 14
"Ov",  # 15

"Sw",  # 16

# Special Argument Codes
"AL",  # 17
"CL",  # 18
"DL",  # 19
"BL",  # 20
"AH",  # 21
"CH",  # 22
"DH",  # 23
"BH",  # 24

"eAX", # 25
"eCX", # 26
"eDX", # 27
"eBX", # 28
"eSP", # 29
"eBP", # 30
"eSI", # 31
"eDI", # 32

"ES",  # 33
"CS",  # 34
"SS",  # 35
"DS",  # 36

"1",   # 37
"3",   # 38
"M",   # 39
]

with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
    vars_1 = "\n".join([f"""@property --{v[0]} {{
  syntax: "<integer>";
  initial-value: {v[2]};
  inherits: true;
}}""" for v in variables])
    # Embedded data needs NO @property declarations or vars_2a entries.
    # Values are inlined directly in readMem dispatch as constants.
    vars_2a = "\n".join([f"--__1{v[0]}: var(--__2{v[0]}, {v[2]});" for v in variables_rw] + [f"--__1{v[0]}: {v[2]};" for v in variables_ro])
    vars_2b = "\n".join([f"--{v[0]}: calc({v[1].replace('&','var(--__1'+v[0]+')')});" for v in variables])
    vars_3 = "\n".join([f"--__2{v[0]}: var(--__0{v[0]}, {v[2]});" for v in variables_rw])
    vars_4 = "\n".join([f"--__0{v[0]}: var(--{v[0]});" for v in variables_rw])
    vars_5 = " ".join([f" {v[0]} var(--{v[0]})" for v in variables if v[3]])
    vars_6 = " ".join([f'"\\a --{v[0]}: " counter({v[0]})' for v in variables if v[3]])

    readmem_1 = """
style(--at:-1): var(--__1AX);
style(--at:-2): var(--__1CX);
style(--at:-3): var(--__1DX);
style(--at:-4): var(--__1BX);
style(--at:-5): var(--__1SP);
style(--at:-6): var(--__1BP);
style(--at:-7): var(--__1SI);
style(--at:-8): var(--__1DI);
style(--at:-9): var(--__1IP);
style(--at:-10):var(--__1ES);
style(--at:-11):var(--__1CS);
style(--at:-12):var(--__1SS);
style(--at:-13):var(--__1DS);
style(--at:-14):var(--__1flags);
style(--at:-21):var(--AH);
style(--at:-22):var(--CH);
style(--at:-23):var(--DH);
style(--at:-24):var(--BH);
style(--at:-31):var(--AL);
style(--at:-32):var(--CL);
style(--at:-33):var(--DL);
style(--at:-34):var(--BL);"""
    #readmem_1 += ";" + ";".join(f"style(--at:{-3-i}):var(--__1r{i})" for i in range(14))
    readmem_1 += ";".join(f"style(--at:{i}):var(--__1m{i})" for i in range(MEM_SIZE))
    readmem_1 += ";" + ";".join(f"style(--at:{i}):var(--__1m{i})" for i in range(EXTERNAL_FUNCTIONS_START,EXTERNAL_FUNCTIONS_END))
    readmem_1 += ";" + ";".join(f"style(--at:{i}):var(--__1m{i})" for i in range(EXTERNAL_IO_START,EXTERNAL_IO_END))
    # Embedded data: read-only memory regions
    if embedded_vars:
        readmem_1 += ";" + ";".join(f"style(--at:{addr}):{byte_val}" for name, addr, byte_val in embedded_vars)

    inst_id1 = ";".join(f"style(--inst0:{v['opcode']}){' and style(--modRm_reg:' + str(v['group']) + ')' if v['group'] is not None else ''}:{v['inst_id']}" for v in all_insts)
    #inst_str1 = ";".join(f"style(--inst{v[2]}:{v[1]}):'{v[0]}'" for v in insts_conv)
    inst_str1 = ";".join(f"style(--instId:{v['inst_id']}):'{v['name']}'" for v in all_insts)

    inst_dest1 = ""
    inst_val1 = ""
    inst_flagfun1 = ""
    for v in all_insts:
      fun = f"--D-{v['name'].replace('.','_').replace(':','_')}"
      if fun + "(" in TEMPL:
        inst_dest1 += f"style(--instId:{v['inst_id']}):{fun}(var(--w));"
      fun = f"--V-{v['name'].replace('.','_').replace(':','_')}"
      if fun + "(" in TEMPL:
        inst_val1 += f"style(--instId:{v['inst_id']}):{fun}(var(--w));"
      fun = f"--F-{v['name'].replace('.','_').replace(':','_')}"
      if fun + "(" in TEMPL:
        inst_flagfun1 += f"style(--instId:{v['inst_id']}):{fun}(var(--baseFlags));"
    inst_dest1 = inst_dest1[:-1]
    inst_val1 = inst_val1[:-1]
    #inst_dest1 = ";".join(f"style(--instId:{v['inst_id']}):--D-{v['name'].replace('.','_')}(var(--w))" for v in all_insts)
    #inst_val1 = ";".join(f"style(--instId:{v['inst_id']}):--V-{v['name'].replace('.','_')}(var(--w))" for v in all_insts)
    #inst_flagfun1 = ";".join(f"style(--instId:{v['inst_id']}):--V-{v['name'].replace('.','_')}(var(--w))" for v in all_insts)

    inst_len1 = ";".join(f"style(--instId:{v['inst_id']}):{v['length']}" for v in all_insts if v['length'] != 1)
    inst_modrm1 = ";".join(f"style(--instId:{v['inst_id']}):1" for v in all_insts if v['modrm'])
    inst_movestack1 = ""
    #inst_movestack1 = ";".join(f"style(--__1IP:{fun[0]}):{2+fun[1]}" for fun in EXTFUNS.values()) + ";"
    inst_movestack1 += ";".join(f"style(--instId:{v['inst_id']}):{v['stack']}" for v in all_insts if v['stack'])

    inst_args1 = ";".join(f"style(--instId:{v['inst_id']}):{args_list.index(v['arg1'])}" for v in all_insts if v['arg1'])
    inst_args2 = ";".join(f"style(--instId:{v['inst_id']}):{args_list.index(v['arg2'])}" for v in all_insts if v['arg2'])

    #inst_argssize1 = ";".join(f"style(--instArg1Type:{v['inst_id']}):{args_list.index(v['arg2'])}" for v in all_insts if v['arg2'])

    inst_flags1 = ";".join(f"style(--instId:{v['inst_id']}):{v['flags']}" for v in all_insts if v['flags'])


    charmap1 = ";".join(f'style(--i:{i}):"{c}"' for i,c in enumerate(epic_charset)) # .replace('\\',"\\\\").replace('"',"'")

    MAX_STRING = 50
    MAX_STRING = 5
    readstr1 = "\n".join(f'--c{i}: --readMem(calc(var(--at) + {i}));' for i in range(1,MAX_STRING));
    readstr2 = ""
    for i in range(MAX_STRING):
      fullstr = ""
      for j in range(i):
        fullstr += f'--i2char(var(--c{j})) '
      readstr2 += f"style(--c{i}:0): {fullstr};" if i < MAX_STRING-1 else f"else:{fullstr}"

    screen_cr = ""
    screen_cc = ""
    #for y in range(SCREEN_HEIGHT):
    #  for x in range(SCREEN_WIDTH):
    #    #screen_cr += f"s{x}x{y} var(--__1m{SCREEN_RAM_POS + x + y*SCREEN_WIDTH}) "
    #    #screen_cc += f"counter(s{x}x{y}) "
    #    screen_cc += f"--i2char(var(--__1m{SCREEN_RAM_POS + x + y*SCREEN_WIDTH})) "
    #  screen_cc += "\"\\a \""

    box_shadow_scrn = "";
    for x in range(128):
      for y in range(4*3):
        mem_off = (x + y*128)
        #box_shadow_scrn += f"{x*2}px {y*2}px rgb(var(--__1m{mem_off}), var(--__1m{mem_off+1}), var(--__1m{mem_off+2})),"
        box_shadow_scrn += f"{x*8}px {y*8+8}px rgb(var(--m{mem_off}), var(--m{mem_off}), var(--m{mem_off})),"
    box_shadow_scrn = box_shadow_scrn[:-1]

    f.write(TEMPL\
.replace("CPU_CYCLE_MS", str(CPU_CYCLE_MS))\
.replace("READMEM_1", readmem_1)\
.replace("INST_STR1", inst_str1)\
.replace("INST_ID1", inst_id1)\
.replace("INST_DEST1", inst_dest1)\
.replace("INST_VAL1", inst_val1)\
.replace("INST_LEN1", inst_len1)\
.replace("INST_MODRM1", inst_modrm1)\
.replace("INST_MOVESTACK1", inst_movestack1)\
.replace("INST_ARGS1", inst_args1)\
.replace("INST_ARGS2", inst_args2)\
.replace("INST_FLAGS1", inst_flags1)\
.replace("INST_FLAGFUN1", inst_flagfun1)\
.replace("READSTR1", readstr1)\
.replace("READSTR2", readstr2)\
.replace("VARS_1", vars_1)\
.replace("VARS_2a", vars_2a)\
.replace("VARS_2b", vars_2b)\
.replace("VARS_3", vars_3)\
.replace("VARS_4", vars_4)\
.replace("VARS_5", vars_5)\
.replace("VARS_6", vars_6)\
.replace("BOX_SHADOW_SCRN", box_shadow_scrn)\
.replace("CHARMAP1", charmap1)\
.replace("SCREEN_CR", screen_cr)\
.replace("SCREEN_CC", screen_cc)\
.replace("SCREEN_RAM_POS", str(SCREEN_RAM_POS))\
.replace("FILE_SIZE_DX", str(sum(len(fb) for _,_,fb in embedded_data) >> 16))\
.replace("FILE_SIZE_AX", str(sum(len(fb) for _,_,fb in embedded_data) & 0xFFFF)));
