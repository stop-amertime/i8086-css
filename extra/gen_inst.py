import json

b2i = []
grp = {}

with open("8086_table.txt", "r") as f:
	for l in f:
		vals = l.replace(" ", "\t").replace("\tDX", "\teDX").strip().split("\t")
		il = len(vals[0])
		if il < 2:
			continue
		elif il == 2:
			b2i.append(vals[1:])
		else:
			group_name = vals[0].split("/")[0]
			if group_name not in grp:
				grp[group_name] = {}
			grp[group_name][vals[0].split("/")[1]] = vals[1:]

print(b2i)
print(grp)

arg_sizes = {
	"0": 1,
	"b": 1,
	"p": 4,
	"w": 2,
	"v": 2,
}

def get_modrm_size(modrm):
	modrm_rm = modrm & 0b111
	modrm_reg = (modrm >> 3) & 0b111
	modrm_mod = modrm >> 6
	if modrm_rm == 0b110 and modrm_mod == 0:
		return 2
	if modrm_mod == 0b01:
		return 1
	if modrm_mod == 0b10:
		return 1
	return 0

def get_arg_size(arg,modrm):
	if len(arg) == 0:
		return 0 
	if arg in ["AL","CL","DL","BL","AH","CH","DH","BH","eAX","eCX","eDX","eBX","eSP","eBP","eSI","eDI","ES","CS","SS","DS","1","3"]:
		return 0
	if arg[0] in "O":
		return 2
	if arg[0] in "GS":
		return 0
	if arg[0] in "EM":
		return "M"
		#return 1 + get_modrm_size(modrm)
	if arg[0] in "AIJ":
		return arg_sizes[arg[1]]
	print(arg,modrm)

args_list = [
"",  # 00 - 0
# Argument Addressing Codes
"Ap",  # 01 - 4

"Eb",  # 02 - M
"Ev",  # 03 - M
"Ew",  # 04 - M

"Gb",  # 05 - 0
"Gv",  # 06 - 0

"I0",  # 07 - 1
"Ib",  # 08 - 1
"Iv",  # 09 - 2
"Iw",  # 10 - 2

"Jb",  # 11 - 1
"Jv",  # 12 - 2

"Mp",  # 13 - M

"Ob",  # 14 - 2
"Ov",  # 15 - 2

"Sw",  # 16 - M

# Special Argument Codes
"AL",  # 17 - 0
"CL",  # 18 - 0
"DL",  # 19 - 0
"BL",  # 20 - 0
"AH",  # 21 - 0
"CH",  # 22 - 0
"DH",  # 23 - 0
"BH",  # 24 - 0

"eAX", # 25 - 0
"eCX", # 26 - 0
"eDX", # 27 - 0
"eBX", # 28 - 0
"eSP", # 29 - 0
"eBP", # 30 - 0
"eSI", # 31 - 0
"eDI", # 32 - 0

"ES",  # 33 - 0
"CS",  # 34 - 0
"SS",  # 35 - 0
"DS",  # 36 - 0

"1",   # 37 - 0
"3",   # 38 - 0
"M",   # 39 - 0
]

all_insts = []
next_inst_id = 1
for i,inst in enumerate(b2i):
	for grp_id in range(8):
		inst_data = {
			"inst_id": -1,
			"opcode": i,
			"opcode_hex": hex(i)[2:],
			"group": None,
			"modrm": False,
			"length": 1,
			"name": inst[0],
			"stack": 0,
			"arg1": None,
			"arg2": None,
			"writing": False,
		}

		inst_len = 1
	
		if "--" in inst:
			continue
		
		is_grp = inst[0][:3] == "GRP"

		if is_grp:
			inst_data["group"] = grp_id
			inst_data["name"] = grp[inst[0]][str(grp_id)][0]
			if inst_data["name"] == "--":
				continue

		filtered_args = [x for x in inst[1:] if len(x)]
		for arg in filtered_args:
			arg_size = get_arg_size(arg, 0)
			if arg_size == "M":
				inst_len += 1
				inst_data["modrm"] = True
			else:
				inst_len += arg_size
		if len(filtered_args) >= 1:
			inst_data["arg1"] = filtered_args[0]
		if len(filtered_args) >= 2:
			inst_data["arg2"] = filtered_args[1]

		inst_data["length"] = inst_len
		inst_data["inst_id"] = next_inst_id

		flags = {
					#---ODITSZ-A-P-C
		            #   O   SZ A P C
			"SUB": 0b000100011010101,
			"SBB": 0b000100011010101, # i didnt check
			"ADD": 0b000100011010101,
			"CMP": 0b000100011010101,
			"DEC": 0b000100011010100,
			"SHL": 0b000100000000001,
			"SHR": 0b000100000000001,
			"XOR": 0b000100011010101, # C=0, O=0, A=?
		   "TEST": 0b000100011000101, # C=0, O=0
		    "AND": 0b000100011000101, # C=0, O=0
		     "OR": 0b000100011000101, # C=0, O=0, A=?
		    "NOT": 0b000100011000101, # i didnt check
		}

		stack_offsets = {
			"PUSH": -2,
			"PUSHF": -2,
			"POP": 2,
			"POPF": 2,
			# RET - Pop from stack: IP - if immediate operand is present: SP = SP + operand
			"RET": 2,
			# RET - Pop from stack: IP, CS - if immediate operand is present: SP = SP + operand
			"RETF": 4,
			# TODO: implement
			#"RET": 0 if inst_data["length"] == 1 else 2,
			#"RETF": 0 if inst_data["length"] == 1 else 2,
			"IRET": 6, # maybe
			"CALL": -2,
			#"INT": -6,
		}
		inst_data["stack"] = stack_offsets.get(inst_data["name"], 0)
		inst_data["flags"] = flags.get(inst_data["name"], 0)
		next_inst_id += 1
		all_insts.append(inst_data)
		print(inst_data)

		if not is_grp:
			break

with open("./x86-instructions-rebane.json", "w") as f:
	json.dump(all_insts, f)

for arg in args_list:
	print(get_arg_size(arg,0))