plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

fun String.javaLiteral(): String = buildString {
    append('"')
    this@javaLiteral.forEach { character ->
        when (character) {
            '\\' -> append("\\\\")
            '"' -> append("\\\"")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            else -> append(character)
        }
    }
    append('"')
}

fun org.gradle.api.provider.ProviderFactory.requiredUpdateSetting(name: String): String =
    gradleProperty(name).orElse(environmentVariable(name)).orNull ?: ""

android {
    namespace = "app.hanni.mvp.android.installer"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
        // The native Rust updater receives these from the same build environment.
        // Empty settings disable the closed-app worker instead of downgrading to
        // an unauthenticated channel.
        buildConfigField("String", "HANNI_MVP_UPDATES_URL", providers.requiredUpdateSetting("HANNI_MVP_UPDATES_URL").javaLiteral())
        buildConfigField("String", "HANNI_MVP_UPDATES_TOKEN", providers.requiredUpdateSetting("HANNI_MVP_UPDATES_TOKEN").javaLiteral())
        val publicKey = file("../../../update-public-key.txt").readText(Charsets.UTF_8).trim()
        buildConfigField("String", "HANNI_MVP_UPDATE_PUBLIC_KEY", publicKey.javaLiteral())
        consumerProguardFiles("consumer-rules.pro")
    }

    buildFeatures { buildConfig = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
}

dependencies {
    implementation("androidx.core:core:1.13.1")
    implementation("androidx.work:work-runtime-ktx:2.10.5")
    implementation("org.bouncycastle:bcprov-jdk18on:1.86")
    implementation(project(":tauri-android"))
    testImplementation("junit:junit:4.13.2")
}
