#!/usr/bin/env python3
"""
Search PubMed for HBV Sm5/6 or related spliced protein literature
"""

from Bio import Entrez
import time

# Set email for NCBI Entrez
Entrez.email = "bio.assistant@example.com"

# Search terms to try
search_terms = [
    "HBV spliced protein",
    "HBV splice variant",
    "hepatitis B spliced RNA",
    "HBSP protein"
]

print("搜索 HBV spliced protein 相关文献...\n")

for term in search_terms:
    print(f"搜索词: {term}")

    try:
        # Search PubMed
        handle = Entrez.esearch(db="pubmed", term=term, retmax=5, sort="relevance")
        record = Entrez.read(handle)
        handle.close()

        id_list = record["IdList"]
        print(f"  找到 {len(id_list)} 篇文献\n")

        if id_list:
            # Fetch details for first 2 papers
            handle = Entrez.efetch(db="pubmed", id=id_list[:2], rettype="abstract", retmode="text")
            abstracts = handle.read()
            handle.close()

            print("=" * 80)
            print(abstracts)
            print("=" * 80)
            print()

            # Only process first successful search
            break

    except Exception as e:
        print(f"  错误: {e}\n")
        continue

    time.sleep(0.5)  # Be nice to NCBI servers

print("\n完成!")
