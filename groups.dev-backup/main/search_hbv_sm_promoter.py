#!/usr/bin/env python3
"""
Search for HBV Sm/Sp promoter related literature
"""

from Bio import Entrez
import time

Entrez.email = "bio.assistant@example.com"

# More specific search terms
search_terms = [
    "HBV Sm promoter",
    "HBV Sp promoter",
    "hepatitis B middle surface protein promoter",
    "HBV preS2/S promoter"
]

print("搜索 HBV Sm/Sp 启动子相关文献...\n")

for term in search_terms:
    print(f"搜索词: {term}")

    try:
        handle = Entrez.esearch(db="pubmed", term=term, retmax=3, sort="relevance")
        record = Entrez.read(handle)
        handle.close()

        id_list = record["IdList"]
        print(f"  找到 {len(id_list)} 篇文献")

        if id_list:
            # Fetch first 2 papers
            handle = Entrez.efetch(db="pubmed", id=id_list[:2], rettype="abstract", retmode="text")
            abstracts = handle.read()
            handle.close()

            print("=" * 80)
            print(abstracts)
            print("=" * 80)
            print()

            break

    except Exception as e:
        print(f"  错误: {e}\n")
        continue

    time.sleep(0.5)

print("\n完成!")
