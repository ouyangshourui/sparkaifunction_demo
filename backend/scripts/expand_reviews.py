"""Expand reviews table to 1000 rows - Python data generation."""
import sys, os, random

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from pyspark.sql import SparkSession
from pyspark.sql.types import StructType, StructField, StringType, IntegerType

import app.config as settings
from app.spark.session import build_spark


def main():
    spark = build_spark()
    spark.sparkContext.setLogLevel("ERROR")
    spark.sql("USE local.default")

    current = spark.sql("SELECT COUNT(*) as cnt FROM local.default.reviews").collect()[0]["cnt"]
    print(f"[expand] Current: {current}")
    if current >= 1000:
        print("[expand] Already >= 1000, done.")
        spark.stop()
        return

    needed = 1000 - current
    print(f"[expand] Generating {needed} new rows in Python...")

    random.seed(42)
    countries = ["CN", "US", "UK"]
    texts_zh = [
        "物流很快，包装好。", "产品一般，不算特别好。", "质量不错，推荐购买。",
        "服务态度好，会再来。", "价格偏高，性价比一般。", "用了一段时间，还行。",
        "包装破损但产品没事。", "颜值很高，老婆喜欢。", "完全不能用，差评！",
        "物流慢，但产品还行。", "客服态度差，不会再买。", "五星好评，推荐大家。",
        "东西还行，就是有点贵。", "用了一周很满意。", "外观不错，功能简单。",
        "包裹丢了，物流显示已签收。", "申请售后一直没人处理。", "购买的商品和描述不一致。",
        "需要发票，请尽快处理。", "账号被锁了，怎么回事？",
    ]
    texts_en = [
        "Good product, recommended.", "Not great, mediocre experience.", "Decent quality, worth the price.",
        "Customer service is nice.", "A bit overpriced but OK.", "Works fine after using for a while.",
        "Package damaged but product OK.", "Looks good, my wife likes it.",
        "Terrible, can't use at all!", "Slow shipping but product is OK.",
        "Bad customer service, won't buy again.", "Five stars, highly recommend.",
        "It's OK but a bit expensive.", "Very satisfied after one week.",
        "Looks nice, simple functions.", "Package lost, tracking says delivered.",
        "After-sales no one handles, terrible.", "Product doesn't match description.",
        "Need invoice ASAP please.", "Account locked, what's wrong?",
    ]

    new_rows = []
    for i in range(needed):
        rid = f"r{current + i + 1:04d}"
        country = random.choice(countries)
        if country == "CN":
            lang = "zh"
            text = random.choice(texts_zh)
        else:
            lang = "en"
            text = random.choice(texts_en)
        sales = random.randint(50, 5000)
        new_rows.append((rid, text, lang, country, sales))

    schema = StructType([
        StructField("id", StringType(), False),
        StructField("text", StringType(), False),
        StructField("lang", StringType(), False),
        StructField("country", StringType(), False),
        StructField("sales", IntegerType(), False),
    ])
    new_df = spark.createDataFrame(new_rows, schema=schema)
    print(f"[expand] new_df count: {new_df.count()}")

    # Append
    new_df.write.format("iceberg").mode("append").save("local.default.reviews")
    print(f"[expand] Append done.")

    # Verify
    total = spark.sql("SELECT COUNT(*) as cnt FROM local.default.reviews").collect()[0]["cnt"]
    print(f"[expand] Verified total: {total}")

    spark.stop()


if __name__ == "__main__":
    main()
